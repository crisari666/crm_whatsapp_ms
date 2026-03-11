# Frontend Integration Examples

## React/TypeScript Example

### 1. Hook for Sync Progress

```typescript
// hooks/useWhatsAppSync.ts
import { useEffect, useState } from 'react';
import { socket } from '../services/socket';

interface SyncProgress {
  nChats: number;
  currentChat: number;
  chatId?: string;
  messagesSynced?: number;
}

export const useWhatsAppSync = (sessionId: string) => {
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Join the session room
    socket.emit('join-session', { sessionId });

    // Listen for sync progress
    const handleSyncProgress = (data: SyncProgress & { sessionId: string }) => {
      if (data.sessionId === sessionId) {
        setSyncProgress(data);
        
        // Check if sync is complete
        if (data.currentChat === data.nChats && data.nChats > 0) {
          setIsSyncing(false);
        }
      }
    };

    socket.on('sync_chats', handleSyncProgress);

    return () => {
      socket.off('sync_chats', handleSyncProgress);
    };
  }, [sessionId]);

  const startSync = async (limitPerChat: number = 100) => {
    try {
      setIsSyncing(true);
      setError(null);
      setSyncProgress(null);

      const response = await fetch(
        `/api/whatsapp-web/session/${sessionId}/sync-chats?limitPerChat=${limitPerChat}`,
        { method: 'POST' }
      );

      if (!response.ok) {
        throw new Error('Failed to start synchronization');
      }

      const result = await response.json();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setIsSyncing(false);
      throw err;
    }
  };

  const progressPercentage = syncProgress
    ? (syncProgress.currentChat / syncProgress.nChats) * 100
    : 0;

  return {
    syncProgress,
    isSyncing,
    error,
    startSync,
    progressPercentage,
  };
};
```

### 2. Sync Progress Component

```typescript
// components/WhatsAppSyncProgress.tsx
import React from 'react';
import { useWhatsAppSync } from '../hooks/useWhatsAppSync';

interface Props {
  sessionId: string;
}

export const WhatsAppSyncProgress: React.FC<Props> = ({ sessionId }) => {
  const { syncProgress, isSyncing, error, startSync, progressPercentage } = 
    useWhatsAppSync(sessionId);

  const handleStartSync = async () => {
    try {
      await startSync(100); // Sync 100 messages per chat
    } catch (err) {
      console.error('Sync failed:', err);
    }
  };

  return (
    <div className="sync-container">
      <h3>WhatsApp Synchronization</h3>
      
      {!isSyncing && !syncProgress && (
        <button onClick={handleStartSync}>
          Start Synchronization
        </button>
      )}

      {isSyncing && syncProgress && (
        <div className="sync-progress">
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          
          <div className="sync-details">
            <p>
              Syncing chat {syncProgress.currentChat} of {syncProgress.nChats}
            </p>
            {syncProgress.chatId && (
              <p className="chat-id">Current: {syncProgress.chatId}</p>
            )}
            {syncProgress.messagesSynced !== undefined && (
              <p className="messages-count">
                Messages synced: {syncProgress.messagesSynced}
              </p>
            )}
            <p className="percentage">{progressPercentage.toFixed(1)}%</p>
          </div>
        </div>
      )}

      {error && (
        <div className="error-message">
          Error: {error}
        </div>
      )}

      {!isSyncing && syncProgress && syncProgress.currentChat === syncProgress.nChats && (
        <div className="success-message">
          ✅ Synchronization completed! {syncProgress.nChats} chats synced.
        </div>
      )}
    </div>
  );
};
```

### 3. CSS Styles

```css
/* styles/sync-progress.css */
.sync-container {
  padding: 20px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  max-width: 500px;
  margin: 20px auto;
}

.sync-container h3 {
  margin-top: 0;
  color: #333;
}

.progress-bar {
  width: 100%;
  height: 30px;
  background-color: #f0f0f0;
  border-radius: 15px;
  overflow: hidden;
  margin: 20px 0;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50, #45a049);
  transition: width 0.3s ease;
}

.sync-details {
  margin-top: 15px;
}

.sync-details p {
  margin: 8px 0;
  color: #666;
}

.chat-id {
  font-family: monospace;
  font-size: 0.9em;
  color: #888;
}

.messages-count {
  font-weight: bold;
  color: #4CAF50;
}

.percentage {
  font-size: 1.2em;
  font-weight: bold;
  color: #333;
  text-align: center;
}

.error-message {
  padding: 10px;
  background-color: #ffebee;
  color: #c62828;
  border-radius: 4px;
  margin-top: 10px;
}

.success-message {
  padding: 10px;
  background-color: #e8f5e9;
  color: #2e7d32;
  border-radius: 4px;
  margin-top: 10px;
}

button {
  background-color: #4CAF50;
  color: white;
  padding: 12px 24px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  transition: background-color 0.3s;
}

button:hover {
  background-color: #45a049;
}

button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}
```

## Vanilla JavaScript Example

```javascript
// sync-manager.js
class WhatsAppSyncManager {
  constructor(sessionId, socket) {
    this.sessionId = sessionId;
    this.socket = socket;
    this.progressCallback = null;
    this.completeCallback = null;
    this.errorCallback = null;
    
    this.init();
  }

  init() {
    // Join session room
    this.socket.emit('join-session', { sessionId: this.sessionId });
    
    // Listen for sync progress
    this.socket.on('sync_chats', (data) => {
      if (data.sessionId === this.sessionId) {
        this.handleProgress(data);
      }
    });
  }

  handleProgress(data) {
    const progress = {
      percentage: (data.currentChat / data.nChats) * 100,
      current: data.currentChat,
      total: data.nChats,
      chatId: data.chatId,
      messagesSynced: data.messagesSynced,
    };

    if (this.progressCallback) {
      this.progressCallback(progress);
    }

    // Check if complete
    if (data.currentChat === data.nChats && data.nChats > 0) {
      if (this.completeCallback) {
        this.completeCallback(data);
      }
    }
  }

  async startSync(limitPerChat = 100) {
    try {
      const response = await fetch(
        `/api/whatsapp-web/session/${this.sessionId}/sync-chats?limitPerChat=${limitPerChat}`,
        { method: 'POST' }
      );

      if (!response.ok) {
        throw new Error('Failed to start synchronization');
      }

      return await response.json();
    } catch (error) {
      if (this.errorCallback) {
        this.errorCallback(error);
      }
      throw error;
    }
  }

  onProgress(callback) {
    this.progressCallback = callback;
    return this;
  }

  onComplete(callback) {
    this.completeCallback = callback;
    return this;
  }

  onError(callback) {
    this.errorCallback = callback;
    return this;
  }

  destroy() {
    this.socket.off('sync_chats');
  }
}

// Usage
const syncManager = new WhatsAppSyncManager('session-123', socket);

syncManager
  .onProgress((progress) => {
    console.log(`Progress: ${progress.percentage.toFixed(1)}%`);
    console.log(`Chat ${progress.current}/${progress.total}`);
    console.log(`Messages: ${progress.messagesSynced}`);
    
    // Update UI
    document.getElementById('progress-bar').style.width = `${progress.percentage}%`;
    document.getElementById('status').textContent = 
      `Syncing chat ${progress.current} of ${progress.total}`;
  })
  .onComplete((data) => {
    console.log('Sync complete!', data);
    document.getElementById('status').textContent = 
      `✅ Synchronized ${data.nChats} chats successfully`;
  })
  .onError((error) => {
    console.error('Sync error:', error);
    document.getElementById('status').textContent = 
      `❌ Error: ${error.message}`;
  });

// Start synchronization
document.getElementById('sync-button').addEventListener('click', async () => {
  try {
    await syncManager.startSync(100);
  } catch (error) {
    console.error('Failed to start sync:', error);
  }
});
```

## HTML Example

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Sync</title>
  <style>
    .sync-container {
      max-width: 600px;
      margin: 50px auto;
      padding: 20px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-family: Arial, sans-serif;
    }
    
    .progress-container {
      margin: 20px 0;
    }
    
    .progress-bar-bg {
      width: 100%;
      height: 30px;
      background-color: #f0f0f0;
      border-radius: 15px;
      overflow: hidden;
    }
    
    .progress-bar {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #4CAF50, #45a049);
      transition: width 0.3s ease;
    }
    
    .status {
      margin: 15px 0;
      padding: 10px;
      background-color: #f9f9f9;
      border-radius: 4px;
      min-height: 20px;
    }
    
    button {
      background-color: #4CAF50;
      color: white;
      padding: 12px 24px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
    }
    
    button:hover {
      background-color: #45a049;
    }
    
    button:disabled {
      background-color: #cccccc;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="sync-container">
    <h2>WhatsApp Synchronization</h2>
    
    <button id="sync-button">Start Synchronization</button>
    
    <div class="progress-container">
      <div class="progress-bar-bg">
        <div id="progress-bar" class="progress-bar"></div>
      </div>
    </div>
    
    <div id="status" class="status">
      Ready to sync
    </div>
    
    <div id="details" class="status" style="font-size: 0.9em; color: #666;">
      <!-- Details will appear here -->
    </div>
  </div>

  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <script src="sync-manager.js"></script>
  <script>
    const socket = io('http://localhost:3000');
    const sessionId = 'your-session-id';
    
    const syncManager = new WhatsAppSyncManager(sessionId, socket);
    
    syncManager
      .onProgress((progress) => {
        document.getElementById('progress-bar').style.width = `${progress.percentage}%`;
        document.getElementById('status').textContent = 
          `Syncing chat ${progress.current} of ${progress.total} (${progress.percentage.toFixed(1)}%)`;
        document.getElementById('details').innerHTML = `
          <strong>Current Chat:</strong> ${progress.chatId || 'N/A'}<br>
          <strong>Messages Synced:</strong> ${progress.messagesSynced || 0}
        `;
      })
      .onComplete((data) => {
        document.getElementById('status').textContent = 
          `✅ Synchronized ${data.nChats} chats successfully!`;
        document.getElementById('sync-button').disabled = false;
      })
      .onError((error) => {
        document.getElementById('status').textContent = 
          `❌ Error: ${error.message}`;
        document.getElementById('sync-button').disabled = false;
      });
    
    document.getElementById('sync-button').addEventListener('click', async () => {
      const button = document.getElementById('sync-button');
      button.disabled = true;
      
      try {
        await syncManager.startSync(100);
      } catch (error) {
        console.error('Failed to start sync:', error);
      }
    });
  </script>
</body>
</html>
```

## Vue.js Example

```vue
<template>
  <div class="sync-container">
    <h3>WhatsApp Synchronization</h3>
    
    <button 
      @click="startSync" 
      :disabled="isSyncing"
      class="sync-button"
    >
      {{ isSyncing ? 'Syncing...' : 'Start Synchronization' }}
    </button>

    <div v-if="syncProgress" class="progress-section">
      <div class="progress-bar">
        <div 
          class="progress-fill" 
          :style="{ width: `${progressPercentage}%` }"
        ></div>
      </div>
      
      <div class="sync-details">
        <p>Chat {{ syncProgress.currentChat }} of {{ syncProgress.nChats }}</p>
        <p v-if="syncProgress.chatId" class="chat-id">
          Current: {{ syncProgress.chatId }}
        </p>
        <p v-if="syncProgress.messagesSynced !== undefined" class="messages-count">
          Messages synced: {{ syncProgress.messagesSynced }}
        </p>
        <p class="percentage">{{ progressPercentage.toFixed(1) }}%</p>
      </div>
    </div>

    <div v-if="error" class="error-message">
      Error: {{ error }}
    </div>

    <div v-if="isComplete" class="success-message">
      ✅ Synchronization completed! {{ syncProgress.nChats }} chats synced.
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { socket } from '@/services/socket';

export default {
  name: 'WhatsAppSyncProgress',
  props: {
    sessionId: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const syncProgress = ref(null);
    const isSyncing = ref(false);
    const error = ref(null);

    const progressPercentage = computed(() => {
      if (!syncProgress.value) return 0;
      return (syncProgress.value.currentChat / syncProgress.value.nChats) * 100;
    });

    const isComplete = computed(() => {
      return syncProgress.value && 
             syncProgress.value.currentChat === syncProgress.value.nChats &&
             !isSyncing.value;
    });

    const handleSyncProgress = (data) => {
      if (data.sessionId === props.sessionId) {
        syncProgress.value = data;
        
        if (data.currentChat === data.nChats && data.nChats > 0) {
          isSyncing.value = false;
        }
      }
    };

    const startSync = async () => {
      try {
        isSyncing.value = true;
        error.value = null;
        syncProgress.value = null;

        const response = await fetch(
          `/api/whatsapp-web/session/${props.sessionId}/sync-chats?limitPerChat=100`,
          { method: 'POST' }
        );

        if (!response.ok) {
          throw new Error('Failed to start synchronization');
        }

        await response.json();
      } catch (err) {
        error.value = err.message;
        isSyncing.value = false;
      }
    };

    onMounted(() => {
      socket.emit('join-session', { sessionId: props.sessionId });
      socket.on('sync_chats', handleSyncProgress);
    });

    onUnmounted(() => {
      socket.off('sync_chats', handleSyncProgress);
    });

    return {
      syncProgress,
      isSyncing,
      error,
      progressPercentage,
      isComplete,
      startSync,
    };
  },
};
</script>

<style scoped>
/* Same CSS as React example */
</style>
```
