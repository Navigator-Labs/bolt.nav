import { useEffect, useCallback, useRef } from 'react';
import { logger } from '~/utils/logger';

export interface IframeMessage {
  type: 'GENERATE_APP' | 'UPDATE_DATA' | 'UPDATE_CHAT' | 'READY' | 'STATUS';
  data?: {
    prompt?: string;
    document?: string;
    documentContent?: string; // For passing document content directly
    metadata?: Record<string, any>;
    apiKeys?: Record<string, string>;
    model?: string;
    provider?: string;
    autoStart?: boolean; // Auto-start generation when data is received
    chatId?: string; // ID of chat to update
    instructions?: string; // Additional instructions to append to chat
  };
  status?: 'idle' | 'generating' | 'complete' | 'error';
  timestamp?: number;
  origin?: string;
}

interface UseIframeMessagingOptions {
  onGenerateApp?: (data: IframeMessage['data']) => void;
  onUpdateData?: (data: IframeMessage['data']) => void;
  onUpdateChat?: (data: IframeMessage['data']) => void;
  allowedOrigins?: string[];
}

export function useIframeMessaging(options: UseIframeMessagingOptions = {}) {
  const { onGenerateApp, onUpdateData, onUpdateChat, allowedOrigins = ['*'] } = options;
  const isIframe = useRef(false);
  const parentOrigin = useRef<string | null>(null);

  // Check if running in iframe
  useEffect(() => {
    try {
      isIframe.current = window.self !== window.top;

      if (isIframe.current) {
        logger.info('Running in iframe mode');

        // Send ready message to parent
        window.parent.postMessage({ type: 'READY', timestamp: Date.now() }, '*');
      }
    } catch {
      // If we can't access window.top, we're in an iframe with different origin
      isIframe.current = true;
      logger.info('Running in cross-origin iframe mode');
      window.parent.postMessage({ type: 'READY', timestamp: Date.now() }, '*');
    }
  }, []);

  // Send message to parent window
  const sendToParent = useCallback((message: IframeMessage) => {
    if (!isIframe.current) {
      logger.warn('Not in iframe, cannot send message to parent');
      return;
    }

    const targetOrigin = parentOrigin.current || '*';
    window.parent.postMessage(message, targetOrigin);
    logger.debug('Sent message to parent:', message);
  }, []);

  // Handle incoming messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Security check: verify origin
      if (allowedOrigins[0] !== '*' && !allowedOrigins.includes(event.origin)) {
        logger.warn('Rejected message from unauthorized origin:', event.origin);
        return;
      }

      // Store parent origin for responses
      if (isIframe.current && !parentOrigin.current) {
        parentOrigin.current = event.origin;
        logger.info('Parent origin detected:', event.origin);
      }

      const message = event.data as IframeMessage;

      // Validate message structure
      if (!message || typeof message !== 'object' || !message.type) {
        return;
      }

      logger.debug('Received iframe message:', message);

      switch (message.type) {
        case 'GENERATE_APP':
          if (onGenerateApp && message.data) {
            logger.info('Triggering app generation from iframe message');
            onGenerateApp(message.data);
          }

          break;

        case 'UPDATE_DATA':
          if (onUpdateData && message.data) {
            logger.info('Updating data from iframe message');
            onUpdateData(message.data);
          }

          break;

        case 'UPDATE_CHAT':
          if (onUpdateChat && message.data) {
            logger.info('Updating chat from iframe message');
            onUpdateChat(message.data);
          }

          break;

        default:
          logger.debug('Unhandled message type:', message.type);
      }
    };

    window.addEventListener('message', handleMessage);

    return () => window.removeEventListener('message', handleMessage);
  }, [onGenerateApp, onUpdateData, onUpdateChat, allowedOrigins, sendToParent]);

  return {
    isIframe: isIframe.current,
    sendToParent,
    parentOrigin: parentOrigin.current,
  };
}
