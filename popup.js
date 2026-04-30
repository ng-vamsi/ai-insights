// popup.js
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const downloadBtn = document.getElementById('downloadBtn');
const playBtn = document.getElementById('playBtn');
const statusDiv = document.getElementById('status');
const statsDiv = document.getElementById('stats');
const durationSpan = document.getElementById('duration');
const chunksSpan = document.getElementById('chunks');
const sizeSpan = document.getElementById('size');
const audioPlayer = document.getElementById('audioPlayer');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const apiKeySection = document.getElementById('apiKeySection');
const transcriptionSection = document.getElementById('transcriptionSection');
const transcriptContainer = document.getElementById('transcriptContainer');

let isRecording = false;
let deepgramApiKey = null;

// Load API key on startup
chrome.storage.local.get(['deepgramApiKey'], (result) => {
  if (result.deepgramApiKey) {
    deepgramApiKey = result.deepgramApiKey;
    apiKeyInput.value = '••••••••••••';
    apiKeyInput.disabled = true;
    apiKeySection.classList.add('configured');
    saveApiKeyBtn.textContent = 'Change';
  }
});

// Save API key
saveApiKeyBtn.addEventListener('click', () => {
  if (apiKeySection.classList.contains('configured')) {
    // Allow editing
    apiKeyInput.value = '';
    apiKeyInput.disabled = false;
    apiKeyInput.focus();
    apiKeySection.classList.remove('configured');
    saveApiKeyBtn.textContent = 'Save';
  } else {
    // Save new key
    const key = apiKeyInput.value.trim();
    if (key.length < 10) {
      alert('Please enter a valid Deepgram API key');
      return;
    }
    
    chrome.storage.local.set({ deepgramApiKey: key }, () => {
      deepgramApiKey = key;
      apiKeyInput.value = '••••••••••••';
      apiKeyInput.disabled = true;
      apiKeySection.classList.add('configured');
      saveApiKeyBtn.textContent = 'Change';
      statusDiv.textContent = 'API key saved successfully!';
      
      // Notify background about the new key
      chrome.runtime.sendMessage({ 
        type: 'SET_DEEPGRAM_KEY', 
        apiKey: key 
      });
    });
  }
});

// Listen for recording stats updates and responses from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RECORDING_STATS') {
    updateStats(message.stats);
  }
  
  if (message.type === 'STOP_RECORDING_RESPONSE') {
    console.log('✅ Received stop recording response:', message.data);
    handleStopResponse(message.data);
  }
  
  if (message.type === 'PLAYBACK_RESPONSE') {
    console.log('✅ Received playback response:', message.data);
    handlePlaybackResponse(message.data);
  }
  
  if (message.type === 'TRANSCRIPTION_UPDATE') {
    console.log('📝 Received transcription:', message.data);
    handleTranscription(message.data);
  }
  
  if (message.type === 'TRANSCRIPTION_ERROR') {
    console.error('❌ Transcription error:', message.error);
    statusDiv.innerHTML = `Status: Transcription error - ${message.error}`;
    // Still show the section so user knows something is happening
    transcriptionSection.classList.add('active');
    transcriptContainer.innerHTML = `<div class="transcript-item" style="border-left-color: red;">⚠️ Error: ${message.error}</div>`;
  }
});

function handleStopResponse(response) {
  isRecording = false;
  
  if (response && response.success) {
    statusDiv.innerHTML = `Status: Recording saved (${response.duration}s)`;
    startBtn.disabled = false;
    downloadBtn.disabled = false;
    playBtn.disabled = false;
    console.log('✅ Recording stopped successfully:', response);
  } else {
    console.error('❌ Invalid response:', response);
    statusDiv.innerHTML = "Status: Error - no valid response";
    startBtn.disabled = false;
  }
}

startBtn.addEventListener('click', async () => {
  // Prevent multiple clicks
  if (isRecording) {
    console.log('Already recording, ignoring click');
    return;
  }
  
  // Check if API key is configured
  if (!deepgramApiKey) {
    statusDiv.innerHTML = "Status: Please configure Deepgram API key first";
    apiKeyInput.focus();
    return;
  }

  // 1. Get the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    statusDiv.textContent = "Error: No active tab found.";
    return;
  }

  // Mark as recording
  isRecording = true;

  // 2. Update UI
  statusDiv.innerHTML = "Status: <span class='recording'>RECORDING...</span>";
  startBtn.disabled = true;
  stopBtn.disabled = false;
  downloadBtn.disabled = true;
  playBtn.disabled = true;
  statsDiv.classList.add('active');
  transcriptionSection.classList.add('active');
  transcriptContainer.innerHTML = ''; // Clear previous transcripts
  audioPlayer.classList.remove('active');
  audioPlayer.pause();
  audioPlayer.src = '';

  // 3. Send message to background.js with API key
  chrome.runtime.sendMessage({ 
    type: 'INIT_RECORDING', 
    tabId: tab.id,
    deepgramApiKey: deepgramApiKey
  });

  console.log('Recording started for tab:', tab.id);
});

stopBtn.addEventListener('click', async () => {
  if (!isRecording) return;

  console.log('Stop button clicked');
  statusDiv.innerHTML = "Status: Stopping...";
  stopBtn.disabled = true;

  // Send stop message - response will come via onMessage listener
  try {
    console.log('Sending STOP_RECORDING message...');
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    console.log('✅ Stop message sent, waiting for response via onMessage...');
    
    // Fallback timeout in case response never arrives
    setTimeout(() => {
      if (isRecording) {
        console.error('❌ No response received after 3 seconds - forcing UI update');
        handleStopResponse({ success: true, chunks: 0, duration: 0 });
      }
    }, 3000);
    
  } catch (err) {
    console.error('Exception stopping:', err);
    statusDiv.innerHTML = `Status: Exception - ${err.message}`;
    isRecording = false;
    startBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', async () => {
  console.log('Download button clicked');
  statusDiv.innerHTML = "Status: Preparing download...";
  downloadBtn.disabled = true;

  chrome.runtime.sendMessage(
    { type: 'DOWNLOAD_RECORDING' },
    (response) => {
      if (response && response.success) {
        const sizeMB = (response.size / 1024 / 1024).toFixed(2);
        statusDiv.innerHTML = `Status: Download started (${sizeMB} MB)`;
        console.log('Download initiated successfully');
      } else {
        statusDiv.innerHTML = `Status: ${response?.error || 'Download failed'}`;
      }
      downloadBtn.disabled = false;
    }
  );
});

playBtn.addEventListener('click', async () => {
  console.log('Play button clicked');
  statusDiv.innerHTML = "Status: Loading audio...";
  playBtn.disabled = true;

  try {
    console.log('Sending GET_RECORDING_BLOB message...');
    chrome.runtime.sendMessage({ type: 'GET_RECORDING_BLOB' });
    console.log('✅ Playback message sent, waiting for response via onMessage...');
    
    // Fallback timeout
    setTimeout(() => {
      if (!audioPlayer.src) {
        console.error('❌ No playback response received after 5 seconds');
        statusDiv.innerHTML = "Status: Playback timeout";
        playBtn.disabled = false;
      }
    }, 5000);
    
  } catch (err) {
    console.error('Exception in playback:', err);
    statusDiv.innerHTML = `Status: Exception - ${err.message}`;
    playBtn.disabled = false;
  }
});

function handlePlaybackResponse(response) {
  console.log('Handling playback response:', response);
  
  if (response && response.success && response.dataUrl) {
    console.log('Setting audio source, data URL length:', response.dataUrl.length);
    audioPlayer.src = response.dataUrl;
    audioPlayer.classList.add('active');
    
    // Wait for audio to be loaded before playing
    audioPlayer.onloadeddata = () => {
      console.log('Audio loaded successfully, duration:', audioPlayer.duration);
      audioPlayer.play()
        .then(() => {
          statusDiv.innerHTML = "Status: Playing...";
          playBtn.disabled = false;
          console.log('Playback started');
        })
        .catch(err => {
          console.error('Play error:', err);
          statusDiv.innerHTML = `Status: Play error - ${err.message}`;
          playBtn.disabled = false;
        });
    };
    
    audioPlayer.onerror = (e) => {
      console.error('Audio element error:', e, audioPlayer.error);
      statusDiv.innerHTML = `Status: Audio error - ${audioPlayer.error?.message || 'Unknown error'}`;
      playBtn.disabled = false;
    };
  } else {
    const errorMsg = response?.error || 'Playback failed - no data';
    console.error('Playback failed:', errorMsg);
    statusDiv.innerHTML = `Status: ${errorMsg}`;
    playBtn.disabled = false;
  }
}

function updateStats(stats) {
  durationSpan.textContent = stats.duration + 's';
  chunksSpan.textContent = stats.chunks;
  const sizeKB = (stats.totalSize / 1024).toFixed(1);
  sizeSpan.textContent = sizeKB + ' KB';
}

// Update audio player event listeners
audioPlayer.addEventListener('ended', () => {
  statusDiv.innerHTML = "Status: Playback finished";
  playBtn.disabled = false;
});

// Handle transcription updates
function handleTranscription(data) {
  console.log('📝 Handling transcription:', data);
  
  const { transcript, is_final, timestamp } = data;
  
  if (!transcript || transcript.trim() === '') {
    console.log('⚠️ Empty transcript, skipping');
    return;
  }
  
  // Make sure section is visible
  if (!transcriptionSection.classList.contains('active')) {
    console.log('✅ Activating transcription section');
    transcriptionSection.classList.add('active');
  }
  
  // Format timestamp
  const time = new Date(timestamp).toLocaleTimeString('en-US', { 
    hour12: false, 
    minute: '2-digit', 
    second: '2-digit' 
  });
  
  // Check if this is an update to an interim transcript
  const existingInterim = transcriptContainer.querySelector('.transcript-item.interim');
  
  if (is_final) {
    console.log('✅ Final transcript:', transcript);
    // Remove interim if exists
    if (existingInterim) {
      existingInterim.remove();
    }
    
    // Add final transcript
    const item = document.createElement('div');
    item.className = 'transcript-item';
    item.innerHTML = `
      <span class="transcript-time">[${time}]</span>
      <span class="transcript-text">${transcript}</span>
    `;
    transcriptContainer.appendChild(item);
    
    // Auto-scroll to bottom
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  } else {
    console.log('📝 Interim transcript:', transcript);
    // Update or create interim transcript
    if (existingInterim) {
      existingInterim.querySelector('.transcript-text').textContent = transcript;
      existingInterim.querySelector('.transcript-time').textContent = `[${time}]`;
    } else {
      const item = document.createElement('div');
      item.className = 'transcript-item interim';
      item.innerHTML = `
        <span class="transcript-time">[${time}]</span>
        <span class="transcript-text">${transcript}</span>
      `;
      transcriptContainer.appendChild(item);
    }
    
    // Auto-scroll to bottom
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  }
}

audioPlayer.addEventListener('pause', () => {
  if (!audioPlayer.ended) {
    statusDiv.innerHTML = "Status: Paused";
  }
});

audioPlayer.addEventListener('play', () => {
  statusDiv.innerHTML = "Status: Playing...";
});