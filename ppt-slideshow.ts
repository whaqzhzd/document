import { loadEditorApi, loadScript, initX2T, convertDocument } from './lib/converter';
import { getOnlyOfficeLang } from './lib/i18n';
import './styles/base.css';

type PptConfig = {
  id: number;
  title: string;
  type: string;
  source: string;
  isActive: boolean;
  fileMissing?: boolean;
  fileName: string;
};

type PptListResponse = {
  featureKey: string;
  activePptId: number | null;
  ppts: PptConfig[];
  total: number;
};

type PresentationEditorViewportController = {
  onPreviewStart: (slideIndex?: number, useCurrentDocument?: unknown, skipFullscreen?: boolean) => void;
  getView?: (name: 'DocumentPreview') => PresentationPreviewPanel | undefined;
  previewPanel?: PresentationPreviewPanel;
};

type PresentationEditorGlobal = {
  getController?: (name: 'Viewport') => PresentationEditorViewportController | undefined;
};

type PresentationApiLike = {
  EndDemonstration?: () => void;
  DemonstrationNextSlide?: () => void;
  DemonstrationGoToSlide?: (slideIndex: number) => void;
  DemonstrationEndShowMessage?: (message: string) => void;
  asc_registerCallback?: (name: string, callback: (...args: unknown[]) => void) => void;
  getCountPages?: () => number;
};

type PresentationPreviewPanel = {
  api?: PresentationApiLike;
  pages?: {
    get?: (key: string) => number;
    set?: (key: string, value: number) => void;
  };
  hide?: (...args: unknown[]) => unknown;
  show?: (...args: unknown[]) => unknown;
  isVisible?: () => boolean;
  onEndDemonstration?: (...args: unknown[]) => unknown;
  __pptSlideshowExitLocked?: boolean;
  __pptSlideshowOriginalHide?: (...args: unknown[]) => unknown;
  __pptSlideshowOriginalEndDemonstration?: () => void;
  __pptSlideshowOriginalNextSlide?: () => void;
  __pptSlideshowInputGuardInstalled?: boolean;
};

type LogMethod = (...args: unknown[]) => void;

type LoggerLike = {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  scope?: (name: string) => LoggerLike;
};

type GameCommand = {
  type?: string;
  payload?: unknown;
  gameId?: string;
};

type DocEditorCustomization = {
  help: boolean;
  about: boolean;
  hideRightMenu: boolean;
  toolbar?: boolean;
  compactHeader?: boolean;
  toolbarNoTabs?: boolean;
  toolbarHideFileName?: boolean;
  statusBar?: boolean;
  comments?: boolean;
  hideRulers?: boolean;
  hideNotes?: boolean;
  features: {
    spellcheck: {
      change: boolean;
    };
  };
  anonymous: {
    request: boolean;
    label: string;
  };
};

declare global {
  interface Window {
    __electronLog?: LoggerLike;
    electronAPI?: {
      ppt?: {
        getAll: (featureKey?: string) => Promise<{
          ok: boolean;
          data?: PptListResponse;
          error?: { message?: string };
        }>;
      };
      game?: {
        sendToHost?: (command: Record<string, unknown>) => void;
        onCommand?: (listener: (command: unknown) => void) => () => void;
      };
    };
  }
}

const DEFAULT_FEATURE_KEY = 'ppt-player';
const SLIDESHOW_SCOPE = 'document-ppt-slideshow';
const statusRoot = document.getElementById('status');
const statusTitle = statusRoot?.querySelector('.status-title');
const statusMessage = statusRoot?.querySelector('.status-message');
const iframeContainer = document.getElementById('iframe');
const currentUrl = new URL(window.location.href);
const featureKey = currentUrl.searchParams.get('featureKey')?.trim() || DEFAULT_FEATURE_KEY;

let runtimeReadyPromise: Promise<void> | null = null;
let editorOperationQueue: Promise<void> = Promise.resolve();
let activeLoadToken = 0;
let isLoadingPresentation = false;
let removeCommandListener: (() => void) | null = null;
let globalErrorLoggingInstalled = false;

const fallbackLogger: LoggerLike = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const baseLogger = window.__electronLog?.scope?.(SLIDESHOW_SCOPE)
  || window.__electronLog
  || fallbackLogger;

const log = {
  info: (...args: unknown[]) => baseLogger.info('[PPT Slideshow]', ...args),
  warn: (...args: unknown[]) => baseLogger.warn('[PPT Slideshow]', ...args),
  error: (...args: unknown[]) => baseLogger.error('[PPT Slideshow]', ...args),
};

const disableServiceWorkerForSlideshow = async () => {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith('document-editor-'))
          .map((name) => caches.delete(name)),
      );
    }
  } catch (error) {
    log.warn('清理 PPT 放映页缓存失败，继续加载当前页面', error);
  }
};

const toErrorPayload = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { value: error };
};

const setStatus = (title: string, message: string, mode: 'loading' | 'error' | 'hidden' = 'loading') => {
  if (!statusRoot || !statusTitle || !statusMessage) {
    return;
  }

  if (mode === 'hidden') {
    statusRoot.classList.add('hidden');
    statusRoot.classList.remove('error');
    return;
  }

  statusRoot.classList.remove('hidden');
  statusRoot.classList.toggle('error', mode === 'error');
  statusTitle.textContent = title;
  statusMessage.textContent = message;
};

const setEditorVisible = (visible: boolean) => {
  iframeContainer?.classList.toggle('ready', visible);
};

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const installGlobalErrorLogging = () => {
  if (globalErrorLoggingInstalled) {
    return;
  }

  globalErrorLoggingInstalled = true;

  window.addEventListener('error', (event) => {
    log.error('捕获到窗口未处理异常', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: toErrorPayload(event.error),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    log.error('捕获到未处理 Promise 异常', {
      reason: toErrorPayload(event.reason),
    });
  });
};

const prepareRuntime = async () => {
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = (async () => {
      log.info('开始初始化 PPT 播放运行时', { featureKey });
      await loadEditorApi();
      await loadScript();
      await initX2T();
      log.info('PPT 播放运行时初始化完成');
    })();
  }

  return runtimeReadyPromise;
};

const getActivePpt = async (): Promise<PptConfig | null> => {
  if (!window.electronAPI?.ppt?.getAll) {
    throw new Error('当前环境缺少 PPT 数据接口');
  }

  const response = await window.electronAPI.ppt.getAll(featureKey);
  if (!response.ok || !response.data) {
    throw new Error(response.error?.message || '加载 PPT 列表失败');
  }

  const activePpt = response.data.ppts.find((ppt) => ppt.isActive && !ppt.fileMissing)
    || response.data.ppts.find((ppt) => !ppt.fileMissing)
    || null;

  if (!activePpt) {
    log.warn('当前实例没有可播放的 PPT', {
      featureKey,
      total: response.data.total,
      hasMissingFile: response.data.ppts.some((ppt) => ppt.fileMissing),
    });
  }

  return activePpt;
};

const buildPresentationSource = (ppt: PptConfig) => {
  if (ppt.type === 'url') {
    return ppt.source;
  }

  return `ppt-resource://entry/${encodeURIComponent(featureKey)}/${ppt.id}/${encodeURIComponent(ppt.fileName)}`;
};

const fetchPresentationFile = async (source: string, fileName: string): Promise<File> => {
  log.info('开始加载 PPT 资源', { source, fileName });
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`PPT 资源加载失败: ${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || 'application/vnd.ms-powerpoint' });
};

const getPresentationEditorGlobal = (): PresentationEditorGlobal | null => {
  const topWindow = window as Window & { PE?: PresentationEditorGlobal };
  if (topWindow.PE) {
    return topWindow.PE;
  }

  const editorFrame = (
    document.querySelector('iframe[name="frameEditor"]')
    || document.querySelector('#iframe iframe')
    || iframeContainer?.querySelector('iframe')
  ) as HTMLIFrameElement | null;
  const frameWindow = editorFrame?.contentWindow as (Window & { PE?: PresentationEditorGlobal }) | null;
  return frameWindow?.PE ?? null;
};

const getEditorDocument = (): Document | null => {
  const editorFrame = (
    document.querySelector('iframe[name="frameEditor"]')
    || document.querySelector('#iframe iframe')
    || iframeContainer?.querySelector('iframe')
  ) as HTMLIFrameElement | null;

  try {
    return editorFrame?.contentDocument ?? editorFrame?.contentWindow?.document ?? null;
  } catch (error) {
    log.warn('Unable to access OnlyOffice iframe while waiting for preview panel', error);
    return null;
  }
};

const isVisibleElement = (element: Element | null) => {
  if (!element) {
    return false;
  }

  const htmlElement = element as HTMLElement;
  const view = htmlElement.ownerDocument.defaultView;
  const style = view?.getComputedStyle(htmlElement);
  const rect = htmlElement.getBoundingClientRect();
  return style?.display !== 'none'
    && style?.visibility !== 'hidden'
    && Number(style?.opacity ?? 1) !== 0
    && rect.width > 0
    && rect.height > 0;
};

const hidePreviewControls = (editorDocument: Document | null = getEditorDocument()) => {
  if (!editorDocument) {
    return;
  }

  const styleId = 'ppt-slideshow-hide-preview-controls';
  if (!editorDocument.getElementById(styleId)) {
    const style = editorDocument.createElement('style');
    style.id = styleId;
    style.textContent = `
      #preview-controls-panel,
      .preview-controls {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    editorDocument.head.appendChild(style);
  }

  editorDocument.querySelectorAll('#preview-controls-panel, .preview-controls').forEach((element) => {
    if (element instanceof HTMLElement) {
      element.style.setProperty('display', 'none', 'important');
      element.style.setProperty('visibility', 'hidden', 'important');
      element.style.setProperty('opacity', '0', 'important');
      element.style.setProperty('pointer-events', 'none', 'important');
    }
  });
};

const getPreviewPanel = (): PresentationPreviewPanel | null => {
  const viewportController = getPresentationEditorGlobal()?.getController?.('Viewport');
  return viewportController?.previewPanel
    ?? viewportController?.getView?.('DocumentPreview')
    ?? null;
};

const getPreviewPageState = (previewPanel: PresentationPreviewPanel | null) => {
  const current = previewPanel?.pages?.get?.('current') ?? 0;
  const count = previewPanel?.pages?.get?.('count')
    ?? previewPanel?.api?.getCountPages?.()
    ?? 0;

  return {
    current,
    count,
    lastIndex: Math.max(0, count - 1),
    isLastSlide: count > 0 && current >= count - 1,
  };
};

const keepPreviewOnLastSlide = (previewPanel: PresentationPreviewPanel | null = getPreviewPanel()) => {
  if (!previewPanel) {
    return;
  }

  const { lastIndex } = getPreviewPageState(previewPanel);
  previewPanel.pages?.set?.('current', lastIndex);
  previewPanel.api?.DemonstrationGoToSlide?.(lastIndex);
  previewPanel.show?.();
  hidePreviewControls();
};

const installLastSlideInputGuard = (
  editorDocument: Document,
  previewPanel: PresentationPreviewPanel,
) => {
  if (previewPanel.__pptSlideshowInputGuardInstalled) {
    return;
  }

  previewPanel.__pptSlideshowInputGuardInstalled = true;

  const shouldBlockNextOrExit = () => getPreviewPageState(previewPanel).isLastSlide;

  const blockIfLastSlide = (event: Event) => {
    if (!shouldBlockNextOrExit()) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    keepPreviewOnLastSlide(previewPanel);
  };

  editorDocument.querySelector('#presentation-preview')?.addEventListener('click', blockIfLastSlide, true);
  editorDocument.querySelector('#presentation-preview')?.addEventListener('mousedown', blockIfLastSlide, true);
  editorDocument.querySelector('#presentation-preview')?.addEventListener('pointerdown', blockIfLastSlide, true);
  editorDocument.querySelector('#presentation-preview')?.addEventListener('touchstart', blockIfLastSlide, true);

  editorDocument.addEventListener('keydown', (event) => {
    const nextOrExitKeys = new Set([
      ' ',
      'ArrowRight',
      'ArrowDown',
      'PageDown',
      'Enter',
      'End',
      'Escape',
    ]);

    if (!nextOrExitKeys.has(event.key) || !shouldBlockNextOrExit()) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    keepPreviewOnLastSlide(previewPanel);
  }, true);
};

const lockPreviewExit = (editorDocument: Document | null = getEditorDocument()) => {
  const previewPanel = getPreviewPanel();
  if (!previewPanel) {
    log.warn('PPT preview panel not found while installing end-show lock');
    return;
  }

  if (!previewPanel.__pptSlideshowExitLocked) {
    previewPanel.__pptSlideshowExitLocked = true;
    previewPanel.__pptSlideshowOriginalHide = previewPanel.hide?.bind(previewPanel);
    previewPanel.__pptSlideshowOriginalEndDemonstration = previewPanel.api?.EndDemonstration?.bind(previewPanel.api);
    previewPanel.__pptSlideshowOriginalNextSlide = previewPanel.api?.DemonstrationNextSlide?.bind(previewPanel.api);

    previewPanel.hide = () => {
      keepPreviewOnLastSlide(previewPanel);
      return previewPanel;
    };

    previewPanel.onEndDemonstration = () => {
      keepPreviewOnLastSlide(previewPanel);
      return previewPanel;
    };

    if (previewPanel.api) {
      previewPanel.api.EndDemonstration = () => {
        keepPreviewOnLastSlide(previewPanel);
      };

      previewPanel.api.DemonstrationNextSlide = () => {
        const state = getPreviewPageState(previewPanel);
        if (state.isLastSlide) {
          keepPreviewOnLastSlide(previewPanel);
          return;
        }

        previewPanel.__pptSlideshowOriginalNextSlide?.();
      };

      previewPanel.api.DemonstrationEndShowMessage?.('');
      previewPanel.api.asc_registerCallback?.('asc_onEndDemonstration', () => {
        keepPreviewOnLastSlide(previewPanel);
      });
    }
  }

  if (editorDocument) {
    installLastSlideInputGuard(editorDocument, previewPanel);
  }

  log.info('PPT end-show exit lock installed', getPreviewPageState(previewPanel));
};

const waitForPresentationPreview = async () => {
  const maxAttempts = 40;
  const retryDelayMs = 100;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const editorDocument = getEditorDocument();
    const previewRoot = editorDocument?.querySelector('#pe-preview') ?? null;
    const presentationRoot = editorDocument?.querySelector('#presentation-preview') ?? null;
    const previewVisible = isVisibleElement(previewRoot);
    const presentationVisible = isVisibleElement(presentationRoot);

    if (previewVisible && presentationVisible) {
      hidePreviewControls(editorDocument);
      lockPreviewExit(editorDocument);
      await delay(250);
      hidePreviewControls(editorDocument);
      lockPreviewExit(editorDocument);
      log.info('PPT preview panel is ready', { attempt });
      return;
    }

    if (attempt === 1 || attempt === 10 || attempt === 20 || attempt === maxAttempts) {
      log.info('Waiting for PPT preview panel', {
        attempt,
        hasPreviewRoot: !!previewRoot,
        hasPresentationRoot: !!presentationRoot,
        previewVisible,
        presentationVisible,
      });
    }

    await delay(retryDelayMs);
  }

  log.warn('Timed out waiting for PPT preview panel; revealing current presentation container');
};

const notifyHostLoaded = () => {
  window.electronAPI?.game?.sendToHost?.({
    type: 'game:loaded',
    gameId: featureKey,
    payload: { gameId: featureKey },
  });
};

const enterPresentationMode = async () => {
  const maxAttempts = 20;
  const retryDelayMs = 300;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const presentationEditor = getPresentationEditorGlobal();
    const viewportController = presentationEditor?.getController?.('Viewport');
    const hasPreviewStart = typeof viewportController?.onPreviewStart === 'function';

    log.info('检查播放入口状态', {
      attempt,
      hasPe: !!presentationEditor,
      hasViewportController: !!viewportController,
      hasPreviewStart,
      skipFullscreen: true,
    });

    if (hasPreviewStart) {
      viewportController.onPreviewStart(0, null, true);
      log.info('已触发 PPT 播放入口', {
        attempt,
        slideIndex: 0,
        skipFullscreen: true,
      });
      await waitForPresentationPreview();
      return;
    }

    await delay(retryDelayMs);
  }

  throw new Error(`播放入口未就绪，重试 ${maxAttempts} 次后仍不可用`);
};

const clearEditorContainer = () => {
  if (!iframeContainer) {
    return;
  }

  setEditorVisible(false);

  while (iframeContainer.firstChild) {
    iframeContainer.removeChild(iframeContainer.firstChild);
  }
};

const buildSlideshowCustomization = (): DocEditorCustomization => ({
  help: false,
  about: false,
  hideRightMenu: true,
  statusBar: false,
  comments: false,
  hideRulers: true,
  hideNotes: true,
  features: {
    spellcheck: {
      change: false,
    },
  },
  anonymous: {
    request: false,
    label: 'Guest',
  },
});

const createPresentationEditor = async (options: {
  fileName: string;
  fileType: string;
  binData: BlobPart;
  media?: Record<string, string>;
  token: number;
}) => {
  await editorOperationQueue;

  let resolveOperation!: () => void;
  let rejectOperation!: (error: unknown) => void;
  const operationPromise = new Promise<void>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  editorOperationQueue = operationPromise;

  try {
    if (window.editor) {
      setEditorVisible(false);
      log.info('销毁上一份 PPT 播放实例');
      try {
        window.editor.destroyEditor();
      } catch (error) {
        log.warn('销毁上一份 PPT 播放实例失败', error);
      }
      window.editor = undefined;
      clearEditorContainer();
      await delay(300);
    } else {
      clearEditorContainer();
    }

    const customization = buildSlideshowCustomization();
    const user = {
      id: `ppt-slideshow-${featureKey}`,
      name: 'PPT Player',
    };
    const docEditorConfig = {
      // This OnlyOffice build reads the current user from top-level config.user,
      // while api.js only validates editorConfig.user. Keep both in sync.
      user,
      documentType: 'slide',
      document: {
        title: options.fileName,
        url: options.fileName,
        fileType: options.fileType,
        info: {
          author: 'PPT Player'
        },
        permissions: {
          edit: false,
          chat: false,
          protect: false,
        },
      },
      editorConfig: {
        lang: getOnlyOfficeLang(),
        mode: 'view',
        user,
        customization,
      },
      events: {
        onAppReady: () => {
          const mediaCount = Object.keys(options.media ?? {}).length;
          log.info('OnlyOffice 应用已就绪，开始打开 PPT 文档', {
            fileName: options.fileName,
            fileType: options.fileType,
            mediaCount,
          });

          if (options.media && mediaCount > 0) {
            window.editor?.sendCommand({
              command: 'asc_setImageUrls',
              data: { urls: options.media },
            });
          }

          window.editor?.sendCommand({
            command: 'asc_openDocument',
            // @ts-expect-error OnlyOffice 运行时接受 x2t 输出的二进制内容
            data: { buf: options.binData },
          });
        },
        onDocumentReady: () => {
          if (options.token !== activeLoadToken) {
            log.warn('文档就绪事件已过期，忽略本次放映触发', {
              fileName: options.fileName,
              token: options.token,
              activeLoadToken,
            });
            return;
          }

          log.info('PPT 文档加载完成，准备进入放映态', {
            fileName: options.fileName,
            fileType: options.fileType,
          });

          void enterPresentationMode()
            .then(() => {
              setEditorVisible(true);
              setStatus('', '', 'hidden');
              notifyHostLoaded();
            })
            .catch((error) => {
              log.error('进入 PPT 播放态失败', error);
              setStatus('PPT 播放失败', error instanceof Error ? error.message : '未知错误', 'error');
            });
        },
        onSave: () => {
          log.warn('播放页收到 onSave 事件，已忽略');
        },
        writeFile: () => {
          log.warn('播放页收到 writeFile 事件，已忽略');
        },
      },
    };

    log.info('准备创建 OnlyOffice DocEditor', {
      featureKey,
      fileName: options.fileName,
      fileType: options.fileType,
      token: options.token,
      documentType: docEditorConfig.documentType,
      user: docEditorConfig.editorConfig.user,
      permissions: docEditorConfig.document.permissions,
      editorMode: docEditorConfig.editorConfig.mode,
      customization: {
        toolbar: customization.toolbar,
        compactHeader: customization.compactHeader,
        toolbarNoTabs: customization.toolbarNoTabs,
        toolbarHideFileName: customization.toolbarHideFileName,
        statusBar: customization.statusBar,
        hideRightMenu: customization.hideRightMenu,
        comments: customization.comments,
        hideRulers: customization.hideRulers,
        hideNotes: customization.hideNotes,
      },
    });

    window.editor = new window.DocsAPI.DocEditor('iframe', docEditorConfig);

    resolveOperation();
  } catch (error) {
    rejectOperation(error);
    throw error;
  }
};

const loadActivePresentation = async (reason: 'initial' | 'reload' | 'start' | 'resume' = 'initial') => {
  if (reason !== 'reload' && isLoadingPresentation) {
    log.info('PPT 正在加载中，忽略重复启动命令', { reason });
    return;
  }

  if ((reason === 'start' || reason === 'resume') && window.editor) {
    log.info('PPT 已加载，忽略重复启动命令', { reason });
    setEditorVisible(true);
    setStatus('', '', 'hidden');
    return;
  }

  const token = Date.now();
  activeLoadToken = token;
  isLoadingPresentation = true;
  setEditorVisible(false);
  setStatus('加载中...', '正在准备 PPT 放映环境...', 'loading');

  try {
    await prepareRuntime();
    const activePpt = await getActivePpt();

    if (!activePpt) {
      setStatus('暂无可播放的 PPT', '请在后台管理中新增并激活一个 PPT 文档', 'error');
      return;
    }

    const source = buildPresentationSource(activePpt);
    const file = await fetchPresentationFile(source, activePpt.fileName);
    const fileType = activePpt.fileName.split('.').pop()?.toLowerCase() || 'pptx';

    log.info('开始转换 PPT 文档', {
      reason,
      featureKey,
      pptId: activePpt.id,
      type: activePpt.type,
      source,
      fileName: activePpt.fileName,
      fileType,
    });

    const converted = await convertDocument(file);
    if (token !== activeLoadToken) {
      log.warn('PPT 加载结果已过期，忽略本次渲染', {
        token,
        activeLoadToken,
        pptId: activePpt.id,
      });
      return;
    }

    await createPresentationEditor({
      fileName: activePpt.fileName,
      fileType,
      binData: converted.bin,
      media: converted.media,
      token,
    });
  } catch (error) {
    log.error('加载 PPT 放映页面失败', error);
    setStatus('PPT 加载失败', error instanceof Error ? error.message : '未知错误', 'error');
  } finally {
    if (token === activeLoadToken) {
      isLoadingPresentation = false;
    }
  }
};

const setupCommandBridge = () => {
  if (!window.electronAPI?.game?.onCommand) {
    log.warn('当前环境缺少 game 命令桥，无法接收主窗口命令');
    return;
  }

  removeCommandListener = window.electronAPI.game.onCommand((command) => {
    const payload = command as GameCommand;
    if (!payload?.type) {
      return;
    }

    if (payload.type === 'ppt:reload') {
      log.info('收到 ppt:reload 命令，重新加载当前 PPT');
      void loadActivePresentation('reload');
      return;
    }

    if (payload.type === 'game:start') {
      log.info('收到 game:start 命令，确保当前 PPT 已加载');
      void loadActivePresentation('start');
      return;
    }

    if (payload.type === 'game:resume') {
      log.info('收到 game:resume 命令');
      if (!window.editor) {
        void loadActivePresentation('resume');
      }
    }
  });
};

window.addEventListener('beforeunload', () => {
  removeCommandListener?.();
  removeCommandListener = null;
  try {
    window.editor?.destroyEditor();
  } catch (error) {
    log.warn('销毁 PPT 播放编辑器失败', error);
  }
});

const bootstrapSlideshow = async () => {
  installGlobalErrorLogging();
  await disableServiceWorkerForSlideshow();
  setupCommandBridge();
  await loadActivePresentation('initial');
};

void bootstrapSlideshow();
