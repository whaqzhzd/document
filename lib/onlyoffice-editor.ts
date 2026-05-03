import 'ranui/message';
import { createObjectURL } from 'ranuts/utils';
import { getDocmentObj } from '../store';
import { getOnlyOfficeLang, t } from './i18n';
import { c_oAscFileType2 } from './file-types';
import type { SaveEvent } from './document-types';
import { getMimeTypeFromExtension } from './document-utils';

// Import converter function to avoid circular dependency
let convertBinToDocumentAndDownloadFn:
  | ((bin: Uint8Array, fileName: string, targetExt?: string) => Promise<any>)
  | null = null;

export function setConverterCallback(
  callback: (bin: Uint8Array, fileName: string, targetExt?: string) => Promise<any>,
): void {
  convertBinToDocumentAndDownloadFn = callback;
}

// Global media mapping object
const media: Record<string, string> = {};

type SlideshowLogLevel = 'info' | 'warn' | 'error';

type PresentationEditorViewportController = {
  onPreviewStart: (slideIndex?: number, useCurrentDocument?: unknown, skipFullscreen?: boolean) => void;
};

type PresentationEditorGlobal = {
  getController?: (name: 'Viewport') => PresentationEditorViewportController | undefined;
};

const emitSlideshowLog = (
  level: SlideshowLogLevel,
  message: string,
  detail?: Record<string, unknown>,
) => {
  const payload = {
    source: 'document-slideshow-log',
    level,
    message,
    detail: detail ?? null,
    timestamp: new Date().toISOString(),
  };

  try {
    const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logger('[Document Slideshow]', message, detail ?? '');
  } catch {
    // noop
  }

  try {
    window.parent?.postMessage(payload, '*');
  } catch (error) {
    console.warn('Failed to post slideshow log to parent window:', error);
  }
};

const getPresentationEditorGlobal = (): PresentationEditorGlobal | null => {
  if (window.PE) {
    return window.PE;
  }

  const iframeContainer = document.getElementById('iframe');
  const editorFrame = iframeContainer?.querySelector('iframe') as HTMLIFrameElement | null;
  const frameWindow = editorFrame?.contentWindow as (Window & { PE?: PresentationEditorGlobal }) | null;
  return frameWindow?.PE ?? null;
};

const startPresentationSlideshowIfNeeded = () => {
  if (!window.__DOCUMENT_SLIDESHOW__) {
    emitSlideshowLog('info', '未启用放映模式，跳过自动进入放映态');
    return;
  }

  emitSlideshowLog('info', '检测到放映模式，准备自动进入 PPT 放映态');

  const maxAttempts = 10;
  const retryDelayMs = 300;

  const start = (attempt: number) => {
    try {
      const presentationEditor = getPresentationEditorGlobal();
      const hasPe = !!presentationEditor;
      const viewportController = presentationEditor?.getController?.('Viewport');
      const hasPreviewStart = typeof viewportController?.onPreviewStart === 'function';

      emitSlideshowLog('info', '检查放映入口状态', {
        attempt,
        hasPe,
        hasViewportController: !!viewportController,
        hasPreviewStart,
      });

      if (!hasPreviewStart) {
        if (attempt >= maxAttempts) {
          emitSlideshowLog('warn', '放映入口未就绪，已达到最大重试次数', {
            attempt,
            maxAttempts,
          });
          return;
        }

        window.setTimeout(() => start(attempt + 1), retryDelayMs);
        return;
      }

      emitSlideshowLog('info', '调用 PPT 放映入口', {
        attempt,
        slideIndex: 0,
        skipFullscreen: false,
      });
      viewportController.onPreviewStart(0, null, false);
      emitSlideshowLog('info', '已触发 PPT 放映入口');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitSlideshowLog('error', '触发 PPT 放映入口失败', {
        attempt,
        error: errorMessage,
      });
      console.error('Failed to start presentation slideshow:', error);
    }
  };

  window.setTimeout(() => start(1), 0);
};

// Editor operation queue to prevent concurrent operations
let editorOperationQueue: Promise<void> = Promise.resolve();

/**
 * Queue editor operations to prevent concurrent editor creation/destruction
 */
async function queueEditorOperation<T>(operation: () => Promise<T>): Promise<T> {
  // Wait for previous operations to complete
  // Add a timeout to prevent infinite waiting
  try {
    await Promise.race([
      editorOperationQueue,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Editor operation queue timeout')), 30000)),
    ]);
  } catch (error) {
    // If timeout, log warning but continue (previous operation may have failed)
    if (error instanceof Error && error.message === 'Editor operation queue timeout') {
      console.warn('Editor operation queue timeout, proceeding anyway');
    } else {
      // Re-throw other errors
      throw error;
    }
  }

  // Create a new promise for this operation
  let resolveOperation: () => void;
  let rejectOperation: (error: any) => void;
  const operationPromise = new Promise<void>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });

  // Update the queue
  editorOperationQueue = operationPromise;

  try {
    const result = await operation();
    resolveOperation!();
    return result;
  } catch (error) {
    rejectOperation!(error);
    throw error;
  }
}

/**
 * Handle file write request (mainly for handling pasted images)
 * @param event - OnlyOffice editor file write event
 */
async function handleWriteFile(event: any) {
  try {
    console.log('Write file event:', event);

    const { data: eventData } = event;
    if (!eventData) {
      console.warn('No data provided in writeFile event');
      return;
    }

    const {
      data: imageData, // Uint8Array image data
      file: fileName, // File name, e.g., "display8image-174799443357-0.png"
      _target, // Target object containing frameOrigin and other info
    } = eventData;

    // Validate data
    if (!imageData || !(imageData instanceof Uint8Array)) {
      throw new Error('Invalid image data: expected Uint8Array');
    }

    if (!fileName || typeof fileName !== 'string') {
      throw new Error('Invalid file name');
    }

    // Extract extension from file name
    const fileExtension = fileName.split('.').pop()?.toLowerCase() || 'png';
    const mimeType = getMimeTypeFromExtension(fileExtension);

    // Create Blob object
    const blob = new Blob([imageData as unknown as BlobPart], { type: mimeType });

    // Create object URL
    const objectUrl = await createObjectURL(blob);
    // Add image URL to media mapping using original file name as key
    media[`media/${fileName}`] = objectUrl;
    window.editor?.sendCommand({
      command: 'asc_setImageUrls',
      data: {
        urls: media,
      },
    });

    window.editor?.sendCommand({
      command: 'asc_writeFileCallback',
      data: {
        // Image base64
        path: objectUrl,
        imgName: fileName,
      },
    });
    console.log(`Successfully processed image: ${fileName}, URL: ${media}`);
  } catch (error: any) {
    console.error('Error handling writeFile:', error);

    // Notify editor that file processing failed
    if (window.editor && typeof window.editor.sendCommand === 'function') {
      window.editor.sendCommand({
        command: 'asc_writeFileCallback',
        data: {
          success: false,
          error: error.message,
        },
      });
    }

    if (event.callback && typeof event.callback === 'function') {
      event.callback({
        success: false,
        error: error.message,
      });
    }
  }
}

async function handleSaveDocument(event: SaveEvent) {
  console.log('Save document event:', event);

  if (event.data && event.data.data) {
    const { data, option } = event.data;
    const { fileName } = getDocmentObj() || {};

    // Determine target format from editor's output format
    let targetFormat = c_oAscFileType2[option.outputformat];

    // Only force CSV format if the original file is CSV
    // This check ensures XLSX and other file types are not affected
    // CSV files are converted to XLSX internally, so editor may return XLSX format
    if (fileName && fileName.toLowerCase().endsWith('.csv')) {
      targetFormat = 'CSV';
      console.log('Original file is CSV, forcing save as CSV format');
    } else {
      // For non-CSV files (XLSX, DOCX, PPTX, etc.), use the format returned by editor
      // This ensures XLSX files are saved as XLSX, not CSV
      console.log(`Saving as ${targetFormat} format (original file: ${fileName})`);
    }

    // Create download
    if (convertBinToDocumentAndDownloadFn) {
      await convertBinToDocumentAndDownloadFn(data.data, fileName, targetFormat);
    } else {
      throw new Error('Converter callback not set');
    }
  }

  // Notify editor that save is complete
  window.editor?.sendCommand({
    command: 'asc_onSaveCallback',
    data: { err_code: 0 },
  });
}

// Public editor creation method
export function createEditorInstance(config: {
  fileName: string;
  fileType: string;
  binData: ArrayBuffer | string;
  media?: any;
}): Promise<void> {
  return queueEditorOperation(async () => {
    const { fileName, fileType, binData, media: mediaUrls } = config;

    // Check if there's an existing editor that needs cleanup
    const hasExistingEditor = !!window.editor;

    // Clean up old editor instance properly
    if (window.editor) {
      try {
        console.log('Destroying previous editor instance...');
        window.editor.destroyEditor();

        // When switching between document types, especially from/to PPT,
        // we need more time for cleanup. PPT editors are particularly resource-intensive.
        // Use longer delay when switching editors or when dealing with presentations
        const isPresentation = fileType === 'pptx' || fileType === 'ppt';
        const destroyDelay = hasExistingEditor && isPresentation ? 400 : hasExistingEditor ? 250 : 150;

        // Wait a bit for destroy to complete
        await new Promise((resolve) => setTimeout(resolve, destroyDelay));
      } catch (error) {
        console.warn('Error destroying previous editor:', error);
      }
      window.editor = undefined;
    }

    // Clean up iframe container to ensure clean state
    const iframeContainer = document.getElementById('iframe');
    if (iframeContainer) {
      // Remove all child elements
      while (iframeContainer.firstChild) {
        iframeContainer.removeChild(iframeContainer.firstChild);
      }
    }

    // Additional delay to ensure cleanup completes before creating new editor
    // This is especially important when switching between different document types
    // When switching editors, especially involving PPT, we need more time
    const isPresentation = fileType === 'pptx' || fileType === 'ppt';
    const cleanupDelay = hasExistingEditor && isPresentation ? 400 : hasExistingEditor ? 250 : 150;
    await new Promise((resolve) => setTimeout(resolve, cleanupDelay));

    const editorLang = getOnlyOfficeLang();
    console.log('Creating new editor instance for:', fileName, 'type:', fileType);

    try {
      window.editor = new window.DocsAPI.DocEditor('iframe', {
        document: {
          title: fileName,
          url: fileName, // Use file name as identifier
          fileType: fileType,
          permissions: {
            edit: true,
            chat: false,
            protect: false,
          },
        },
        editorConfig: {
          lang: editorLang,
          customization: {
            help: false,
            about: false,
            hideRightMenu: true,
            features: {
              spellcheck: {
                change: false,
              },
            },
            anonymous: {
              request: false,
              label: 'Guest',
            },
          },
        },
        events: {
          onAppReady: () => {
            // Set media resources
            if (mediaUrls) {
              window.editor?.sendCommand({
                command: 'asc_setImageUrls',
                data: { urls: mediaUrls },
              });
            }

            // Load document content
            window.editor?.sendCommand({
              command: 'asc_openDocument',
              // @ts-expect-error binData type is handled by the editor
              data: { buf: binData },
            });
          },
          onDocumentReady: () => {
            console.log(`${t('documentLoaded')}${fileName}`);
            emitSlideshowLog('info', '文档加载完成', {
              fileName,
              fileType,
              slideshowEnabled: !!window.__DOCUMENT_SLIDESHOW__,
            });
            if (fileType === 'pptx' || fileType === 'ppt') {
              startPresentationSlideshowIfNeeded();
            }
            // Note: For CSV files, the save dialog may show XLSX format,
            // but the actual save will be forced to CSV format in handleSaveDocument
          },
          onSave: handleSaveDocument,
          // writeFile
          // TODO: writeFile - handle when pasting images from external sources
          writeFile: handleWriteFile,
        },
      });
    } catch (error) {
      console.error('Error creating editor instance:', error);
      throw error;
    }
  });
}

export function loadEditorApi(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (window.DocsAPI) {
      resolve();
      return;
    }

    // Load editor API
    const script = document.createElement('script');
    script.src = './web-apps/apps/api/documents/api.js';
    script.onload = () => resolve();
    script.onerror = (error) => {
      console.error('Failed to load OnlyOffice API:', error);
      alert(t('failedToLoadEditor'));
      reject(error);
    };
    document.head.appendChild(script);
  });
}
