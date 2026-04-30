// background.js
console.log('🚀 Background service worker loaded');

// Storage for audio recording
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTabId = null;
let deepgramApiKey = null;
let deepgramSocket = null;
let deepgramConnected = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    
    console.log('📨 Message received in background.js:', message )

  // Handle SET_DEEPGRAM_KEY
  if (message.type === 'SET_DEEPGRAM_KEY') {
    deepgramApiKey = message.apiKey;
    console.log('🔑 Deepgram API key configured');
    return false;
  }

  // Handle INIT_RECORDING with async operations
  if (message.type === 'INIT_RECORDING') {
    deepgramApiKey = message.deepgramApiKey || deepgramApiKey;
    handleInitRecording(message.tabId);
    return false; // No response needed
  }

  // Handle audio chunks from offscreen.js
  if (message.type === 'AUDIO_DATA_CHUNK') {
    handleAudioChunk(message.payload);
    return false; // No response needed
  }

  // Handle stop recording request
  if (message.type === 'STOP_RECORDING') {
    return handleStopRecording(sendResponse); // Returns true to keep channel open
  }

  // Handle download request
  if (message.type === 'DOWNLOAD_RECORDING') {
    handleDownloadRecording(sendResponse);
    return true; // Keep channel open for async response
  }

  // Handle playback request
  if (message.type === 'GET_RECORDING_BLOB') {
    handleGetRecordingBlob(sendResponse);
    return true; // Keep channel open for async response
  }
  
  // Unknown message type
  return false;
});

// Separate async function for init recording
async function handleInitRecording(tabId) {
  console.log('🎬 Starting recording initialization...');

  // Reset storage for new recording
  audioChunks = [];
  isRecording = true;
  recordingStartTime = Date.now();
  recordingTabId = tabId;
  console.log('📝 Recording state initialized');

  // Initialize Deepgram connection if API key is available
  if (deepgramApiKey) {
    initDeepgramConnection();
  } else {
    console.warn('⚠️ No Deepgram API key - transcription disabled');
  }

  // 1. Get the stream ID for the specific tab
  console.log('📺 Getting stream ID for tab:', tabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  console.log('✅ Stream ID obtained:', streamId);

  // 2. Check if offscreen document already exists
  console.log('🔍 Checking for existing offscreen document...');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  console.log('📊 Offscreen contexts found:', existingContexts.length);

  if (existingContexts.length === 0) {
    console.log('📄 Creating new offscreen document...');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
      justification: 'To capture and mix tab/mic audio for sales insights'
    });
    console.log('✅ Offscreen document created');
  } else {
    console.log('✅ Offscreen document already exists, reusing it');
  }

  // 3. Send the streamId to the Offscreen document
  console.log('⏱️ Waiting 1 second for offscreen document to load...');
  setTimeout(() => {
    console.log('📤 Sending START_RECORDING message to offscreen...');
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_RECORDING',
      data: { streamId, tabId }
    });
    console.log('✅ Message sent to offscreen document');
  }, 1000);
}

// Initialize Deepgram WebSocket connection
function initDeepgramConnection() {
  console.log('🌐 Initializing Deepgram connection...');
  console.log('🔑 Using API key:', deepgramApiKey ? `${deepgramApiKey.substring(0, 10)}...` : 'NONE');
  
  try {
    // Deepgram WebSocket URL with parameters
    // Using 'webm_opus' encoding to match our MediaRecorder format
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?` + new URLSearchParams({
      model: 'nova-2',
      language: 'en',
      punctuate: 'true',
      interim_results: 'true',
      encoding: 'opus',
      channels: '1'
    }).toString();
    
    console.log('🔗 Connecting to:', deepgramUrl);
    deepgramSocket = new WebSocket(deepgramUrl, ['token', deepgramApiKey]);
    
    deepgramSocket.onopen = () => {
      console.log('✅ Deepgram WebSocket connected');
      deepgramConnected = true;
      
      // Notify popup
      chrome.runtime.sendMessage({
        type: 'TRANSCRIPTION_UPDATE',
        data: {
          transcript: 'Transcription service connected...',
          is_final: true,
          timestamp: Date.now()
        }
      }).catch(() => {});
    };
    
    deepgramSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('📨 Deepgram message:', data);
        
        // Handle metadata message
        if (data.type === 'Metadata') {
          console.log('ℹ️ Deepgram metadata:', data);
          return;
        }
        
        // Handle results message
        if (data.type === 'Results' || data.channel) {
          if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
            const alternative = data.channel.alternatives[0];
            const transcript = alternative.transcript;
            const is_final = data.is_final || false;
            
            console.log(`📝 Transcription (${is_final ? 'final' : 'interim'}):`, transcript);
            
            if (transcript && transcript.trim() !== '') {
              // Send to popup
              chrome.runtime.sendMessage({
                type: 'TRANSCRIPTION_UPDATE',
                data: {
                  transcript: transcript,
                  is_final: is_final,
                  timestamp: Date.now()
                }
              }).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.error('❌ Error parsing Deepgram response:', err, event.data);
      }
    };
    
    deepgramSocket.onerror = (error) => {
      console.error('❌ Deepgram WebSocket error:', error);
      deepgramConnected = false;
      
      chrome.runtime.sendMessage({
        type: 'TRANSCRIPTION_ERROR',
        error: 'WebSocket connection error'
      }).catch(() => {});
    };
    
    deepgramSocket.onclose = () => {
      console.log('🔌 Deepgram WebSocket closed');
      deepgramConnected = false;
    };
    
  } catch (err) {
    console.error('❌ Error initializing Deepgram:', err);
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPTION_ERROR',
      error: err.message
    }).catch(() => {});
  }
}

function handleAudioChunk(payload) {
  const { data, size, mimeType } = payload;
  
  console.log('🎵 Received audio chunk from offscreen');
  console.log('📊 Audio chunk details - Size:', size, 'bytes, Type:', mimeType);
  console.log('📦 Array length:', data.length, 'bytes');
  
  // Convert Array back to Uint8Array, then to Blob
  const uint8Array = new Uint8Array(data);
  const audioBlob = new Blob([uint8Array], { type: mimeType });
  console.log('✅ Converted to Blob:', audioBlob, 'Actual size:', audioBlob.size);
  
  // Store the audio chunk
  if (isRecording) {
    audioChunks.push(audioBlob);
    const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
    console.log('💾 Stored chunk #' + audioChunks.length + ' | Duration:', duration + 's | Total chunks:', audioChunks.length);
    
    // Send to Deepgram if connected
    if (deepgramConnected && deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
      try {
        // Send WebM/Opus audio directly to Deepgram
        audioBlob.arrayBuffer().then(buffer => {
          deepgramSocket.send(buffer);
          console.log('📤 Sent audio to Deepgram:', buffer.byteLength, 'bytes, Format: audio/webm;codecs=opus');
        }).catch(err => {
          console.error('❌ Error converting audio to buffer:', err);
        });
      } catch (err) {
        console.error('❌ Error sending to Deepgram:', err);
      }
    } else {
      console.warn('⚠️ Not sending to Deepgram - Connected:', deepgramConnected, 'Socket state:', deepgramSocket?.readyState);
    }
    
    // Update popup with recording stats
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATS',
      stats: {
        chunks: audioChunks.length,
        duration: duration,
        totalSize: audioChunks.reduce((sum, chunk) => sum + chunk.size, 0)
      }
    }).catch(() => {
      // Popup might be closed, that's ok
    });
  }
}

function handleStopRecording(sendResponse) {
  console.log('🛑 Stop recording requested');
  console.log('Current state - isRecording:', isRecording, 'chunks:', audioChunks.length);
  
  isRecording = false;
  
  // Close Deepgram connection
  if (deepgramSocket) {
    console.log('🔌 Closing Deepgram connection...');
    try {
      // Send closing message to Deepgram
      if (deepgramSocket.readyState === WebSocket.OPEN) {
        deepgramSocket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      deepgramSocket.close();
      deepgramSocket = null;
      deepgramConnected = false;
      console.log('✅ Deepgram connection closed');
    } catch (err) {
      console.error('Error closing Deepgram:', err);
    }
  }
  
  const duration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
  const responseData = { 
    success: true, 
    chunks: audioChunks.length,
    duration: duration 
  };
  
  console.log('✅ Recording stopped - Duration:', duration + 's, Chunks:', audioChunks.length);
  console.log('📤 Sending stop response via message:', responseData);
  
  // Send response as a separate message instead of using sendResponse
  chrome.runtime.sendMessage({
    type: 'STOP_RECORDING_RESPONSE',
    data: responseData
  }).catch(err => {
    console.error('Failed to send stop response:', err);
  });
  
  // Handle offscreen cleanup
  setTimeout(() => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'STOP_RECORDING'
    }).catch(() => {
      // Offscreen might be gone, that's ok
    });
  }, 100);
  
  return false; // Don't use sendResponse callback
}

function handleDownloadRecording(sendResponse) {
  console.log('💾 Download requested - Combining', audioChunks.length, 'chunks');
  
  if (audioChunks.length === 0) {
    sendResponse({ success: false, error: 'No audio chunks recorded' });
    return;
  }
  
  // Combine all chunks into one blob
  const finalBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
  console.log('✅ Combined blob size:', finalBlob.size, 'bytes');
  
  // Convert to data URL for download
  const reader = new FileReader();
  reader.onloadend = () => {
    const dataUrl = reader.result;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `recording-${timestamp}.webm`;
    
    // Trigger download
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      console.log('📥 Download started:', filename, 'Download ID:', downloadId);
    });
  };
  reader.readAsDataURL(finalBlob);
  
  sendResponse({ success: true, size: finalBlob.size });
}

function handleGetRecordingBlob(sendResponse) {
  console.log('🎧 Playback requested');
  
  if (audioChunks.length === 0) {
    console.error('❌ No audio chunks available for playback');
    chrome.runtime.sendMessage({
      type: 'PLAYBACK_RESPONSE',
      data: { success: false, error: 'No audio chunks recorded' }
    }).catch(() => {});
    return;
  }
  
  try {
    console.log('📦 Creating final blob from', audioChunks.length, 'chunks');
    const finalBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
    console.log('✅ Final blob created, size:', finalBlob.size, 'bytes');
    
    const reader = new FileReader();
    
    reader.onloadend = () => {
      console.log('✅ Data URL created, length:', reader.result.length);
      chrome.runtime.sendMessage({
        type: 'PLAYBACK_RESPONSE',
        data: { success: true, dataUrl: reader.result }
      }).catch(err => {
        console.error('Failed to send playback response:', err);
      });
    };
    
    reader.onerror = (error) => {
      console.error('❌ FileReader error:', error);
      chrome.runtime.sendMessage({
        type: 'PLAYBACK_RESPONSE',
        data: { success: false, error: 'Failed to read audio data' }
      }).catch(() => {});
    };
    
    console.log('📖 Reading blob as data URL...');
    reader.readAsDataURL(finalBlob);
  } catch (err) {
    console.error('❌ Exception in GET_RECORDING_BLOB:', err);
    chrome.runtime.sendMessage({
      type: 'PLAYBACK_RESPONSE',
      data: { success: false, error: err.message }
    }).catch(() => {});
  }
}