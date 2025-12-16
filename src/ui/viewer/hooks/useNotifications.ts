import { useState, useEffect, useCallback, useRef } from 'react';

interface UseNotificationsReturn {
  permission: NotificationPermission | 'unsupported';
  requestPermission: () => Promise<boolean>;
  notifyStuck: (toolName: string, duration: string) => void;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export function useNotifications(): UseNotificationsReturn {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [enabled, setEnabledState] = useState(false);
  const notifiedIdsRef = useRef<Set<number>>(new Set());

  // Check if notifications are supported
  useEffect(() => {
    if (!('Notification' in window)) {
      setPermission('unsupported');
      return;
    }
    setPermission(Notification.permission);

    // Load enabled state from localStorage
    const stored = localStorage.getItem('claude-mem-queue-notifications');
    if (stored === 'true' && Notification.permission === 'granted') {
      setEnabledState(true);
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!('Notification' in window)) {
      return false;
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result === 'granted';
    } catch (error) {
      console.error('Failed to request notification permission:', error);
      return false;
    }
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    localStorage.setItem('claude-mem-queue-notifications', value ? 'true' : 'false');

    // Request permission if enabling and not yet granted
    if (value && Notification.permission === 'default') {
      requestPermission();
    }
  }, [requestPermission]);

  const notifyStuck = useCallback((toolName: string, duration: string) => {
    if (!enabled || permission !== 'granted') {
      return;
    }

    const notification = new Notification('Claude-Mem: Message Stuck', {
      body: `"${toolName}" has been processing for ${duration}. Click to view queue.`,
      icon: '/claude-mem-logomark.webp',
      tag: 'claude-mem-stuck' // Prevents duplicate notifications
    });

    notification.onclick = () => {
      window.focus();
      // Dispatch custom event to open drawer
      window.dispatchEvent(new CustomEvent('open-queue-drawer'));
      notification.close();
    };
  }, [enabled, permission]);

  // Clear notified IDs when messages change
  const clearNotifiedId = useCallback((id: number) => {
    notifiedIdsRef.current.delete(id);
  }, []);

  return {
    permission,
    requestPermission,
    notifyStuck,
    enabled,
    setEnabled
  };
}
