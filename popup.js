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
const openaiKeyInput = document.getElementById('openaiKeyInput');
const saveOpenaiKeyBtn = document.getElementById('saveOpenaiKeyBtn');
const apiKeySection = document.getElementById('apiKeySection');
const transcriptionSection = document.getElementById('transcriptionSection');
const transcriptContainer = document.getElementById('transcriptContainer');
const insightsSection = document.getElementById('insightsSection');
const insightsContainer = document.getElementById('insightsContainer');
const generateAISummaryBtn = document.getElementById('generateAISummaryBtn');

let isRecording = false;
let deepgramApiKey = null;
let currentTranscriptText = '';

// Load API key on startup
chrome.storage.local.get(['deepgramApiKey', 'openaiApiKey'], (result) => {
  if (result.deepgramApiKey) {
    deepgramApiKey = result.deepgramApiKey;
    apiKeyInput.value = '••••••••••••';
    apiKeyInput.disabled = true;
    apiKeySection.classList.add('configured');
    saveApiKeyBtn.textContent = 'Change';
  }
  
  if (result.openaiApiKey) {
    openaiKeyInput.value = '••••••••••••';
    openaiKeyInput.disabled = true;
    saveOpenaiKeyBtn.textContent = 'Change';
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

// Save OpenAI API key (optional)
saveOpenaiKeyBtn.addEventListener('click', () => {
  if (openaiKeyInput.disabled) {
    // Allow editing
    openaiKeyInput.value = '';
    openaiKeyInput.disabled = false;
    openaiKeyInput.focus();
    saveOpenaiKeyBtn.textContent = 'Save';
  } else {
    // Save new key
    const key = openaiKeyInput.value.trim();
    if (key.length > 0 && key.length < 20) {
      alert('Please enter a valid OpenAI API key');
      return;
    }
    
    if (key.length === 0) {
      // Clear the key
      chrome.storage.local.remove('openaiApiKey', () => {
        openaiKeyInput.value = '';
        openaiKeyInput.disabled = false;
        saveOpenaiKeyBtn.textContent = 'Save';
        statusDiv.textContent = 'OpenAI key removed';
      });
      return;
    }
    
    chrome.storage.local.set({ openaiApiKey: key }, () => {
      openaiKeyInput.value = '••••••••••••';
      openaiKeyInput.disabled = true;
      saveOpenaiKeyBtn.textContent = 'Change';
      statusDiv.textContent = 'OpenAI key saved! You can now use deep AI analysis.';
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
  
  if (message.type === 'INSIGHTS_READY') {
    console.log('💡 Received insights:', message.data);
    displayInsights(message.data);
  }
  
  if (message.type === 'LIVE_INSIGHTS_UPDATE') {
    console.log('📊 Received live insights:', message.data);
    displayLiveInsights(message.data);
  }
  
  if (message.type === 'AI_SUMMARY_READY') {
    console.log('🤖 Received AI summary:', message.data);
    displayAISummary(message.data);
  }
  
  if (message.type === 'AI_SUMMARY_ERROR') {
    console.error('❌ AI summary error:', message.error);
    generateAISummaryBtn.disabled = false;
    generateAISummaryBtn.textContent = 'Deep Analysis';
    alert('Error generating AI summary: ' + message.error);
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
  insightsSection.classList.add('active'); // Show insights during recording
  transcriptContainer.innerHTML = ''; // Clear previous transcripts
  insightsContainer.innerHTML = '<div class="insight-card"><div class="insight-label">Live Insights</div><div class="insight-value">Analyzing conversation in real-time...</div></div>';
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

// Display insights
function displayInsights(insights) {
  console.log('📊 Displaying insights:', insights);
  
  // Show insights section
  insightsSection.classList.add('active');
  
  let html = '';
  
  // Summary
  if (insights.summary) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Summary</div>
        <div class="insight-value">${insights.summary}</div>
      </div>
    `;
  }
  
  // Stats
  if (insights.stats) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Statistics</div>
        <div class="stat-grid">
          <div class="stat-item">
            <div class="stat-number">${insights.stats.wordCount || 0}</div>
            <div class="stat-label">Words</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">${insights.stats.questions || 0}</div>
            <div class="stat-label">Questions</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">${insights.stats.segments || 0}</div>
            <div class="stat-label">Segments</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">${insights.stats.speakers || 'N/A'}</div>
            <div class="stat-label">Speakers</div>
          </div>
        </div>
      </div>
    `;
  }
  
  // Sentiment
  if (insights.sentiment && insights.sentiment.dominant) {
    const sentiment = insights.sentiment.dominant;
    const sentimentClass = `sentiment-${sentiment}`;
    const sentimentLabel = sentiment === 'positive' ? 'Positive' : sentiment === 'negative' ? 'Negative' : 'Neutral';
    
    html += `
      <div class="insight-card">
        <div class="insight-label">Overall Sentiment</div>
        <div class="insight-value ${sentimentClass}">
          ${sentimentLabel}
        </div>
        <div class="stat-grid" style="margin-top: 5px;">
          <div class="stat-item">
            <div class="stat-number sentiment-positive">${insights.sentiment.breakdown?.positive || 0}</div>
            <div class="stat-label">Positive</div>
          </div>
          <div class="stat-item">
            <div class="stat-number sentiment-neutral">${insights.sentiment.breakdown?.neutral || 0}</div>
            <div class="stat-label">Neutral</div>
          </div>
          <div class="stat-item">
            <div class="stat-number sentiment-negative">${insights.sentiment.breakdown?.negative || 0}</div>
            <div class="stat-label">Negative</div>
          </div>
        </div>
      </div>
    `;
  }
  
  // Key Phrases
  if (insights.keyPhrases && insights.keyPhrases.length > 0) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Key Phrases</div>
        <div class="key-phrases">
          ${insights.keyPhrases.map(phrase => 
            `<span class="phrase-tag">${phrase}</span>`
          ).join('')}
        </div>
      </div>
    `;
  }
  
  // Topics (from Deepgram)
  if (insights.topics && insights.topics.length > 0) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Detected Topics</div>
        <div class="key-phrases">
          ${insights.topics.map(topic => 
            `<span class="phrase-tag" style="background: #e8f5e9; color: #2e7d32; border-color: #2e7d32;">${topic}</span>`
          ).join('')}
        </div>
      </div>
    `;
  }
  
  // Action Items
  if (insights.actionItems && insights.actionItems.length > 0) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Action Items (${insights.actionItems.length})</div>
        <div class="action-list">
          ${insights.actionItems.map(item => 
            `<div class="action-item">${item}</div>`
          ).join('')}
        </div>
      </div>
    `;
  }
  
  insightsContainer.innerHTML = html;
  
  // Store transcript for AI analysis
  currentTranscriptText = insights.fullText || '';
  
  // Auto-scroll to insights
  setTimeout(() => {
    insightsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

// Display AI-generated summary
function displayAISummary(summary) {
  generateAISummaryBtn.disabled = false;
  generateAISummaryBtn.textContent = 'Deep Analysis';
  
  const aiCard = document.createElement('div');
  aiCard.className = 'insight-card';
  aiCard.style.background = '#f0f8ff';
  aiCard.style.border = '2px solid #4285f4';
  aiCard.innerHTML = `
    <div class="insight-label">AI-Powered Deep Analysis</div>
    <div class="insight-value" style="white-space: pre-wrap; line-height: 1.4;">${summary}</div>
  `;
  
  insightsContainer.insertBefore(aiCard, insightsContainer.firstChild);
  
  // Scroll to show the new summary
  aiCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Display live insights during recording
function displayLiveInsights(insights) {
  if (!insights) return;
  
  let html = '';
  
  // Live indicator
  html += `
    <div class="insight-card" style="background: #e8f5e9; border-left: 3px solid #4caf50;">
      <div class="insight-label">Live Insights (Updating...)</div>
      <div class="insight-value" style="font-size: 10px; color: #666;">Stats update as you speak</div>
    </div>
  `;
  
  // SALES-SPECIFIC INSIGHTS
  if (insights.salesInsights) {
    const si = insights.salesInsights;
    
    // Intent Score
    html += `
      <div class="insight-card" style="background: #fff8e1; border-left: 3px solid #ffc107;">
        <div class="insight-label">Buyer Intent</div>
        <div class="insight-value" style="font-weight: 600; color: #f57c00;">${si.intentScore}</div>
      </div>
    `;
    
    // Engagement Level
    html += `
      <div class="insight-card">
        <div class="insight-label">Engagement Level</div>
        <div class="insight-value" style="font-weight: 600; color: ${
          si.engagementLevel === 'Very High' ? '#4caf50' :
          si.engagementLevel === 'High' ? '#8bc34a' :
          si.engagementLevel === 'Medium' ? '#ffc107' : '#ff9800'
        };">${si.engagementLevel}</div>
      </div>
    `;
    
    // Emotional State
    if (si.emotions && si.emotions.length > 0) {
      html += `
        <div class="insight-card">
          <div class="insight-label">Prospect Feeling</div>
          <div class="key-phrases">
            ${si.emotions.map(emotion => 
              `<span class="phrase-tag" style="background: #e3f2fd; color: #1976d2; border-color: #1976d2;">${emotion}</span>`
            ).join('')}
          </div>
        </div>
      `;
    }
    
    // Buying Signals
    if (si.buyingSignals && si.buyingSignals.length > 0) {
      html += `
        <div class="insight-card" style="background: #e8f5e9;">
          <div class="insight-label">Buying Signals (${si.buyingSignals.length})</div>
          <div class="action-list">
            ${si.buyingSignals.map(({ text, signal }) => 
              `<div class="action-item" style="background: #c8e6c9; border-left-color: #4caf50;">
                <strong style="color: #2e7d32;">${signal}</strong><br>
                <span style="font-size: 9px;">"${text}"</span>
              </div>`
            ).join('')}
          </div>
        </div>
      `;
    }
    
    // Objections
    if (si.objections && si.objections.length > 0) {
      html += `
        <div class="insight-card" style="background: #ffebee;">
          <div class="insight-label">Objections Detected (${si.objections.length})</div>
          <div class="action-list">
            ${si.objections.map(({ text, type }) => 
              `<div class="action-item" style="background: #ffcdd2; border-left-color: #f44336;">
                <strong style="color: #c62828;">${type}</strong><br>
                <span style="font-size: 9px;">"${text}"</span>
              </div>`
            ).join('')}
          </div>
        </div>
      `;
    }
    
    // Pain Points
    if (si.painPoints && si.painPoints.length > 0) {
      html += `
        <div class="insight-card" style="background: #fff3e0;">
          <div class="insight-label">Pain Points Mentioned</div>
          <div class="action-list">
            ${si.painPoints.map(point => 
              `<div class="action-item" style="background: #ffe0b2; border-left-color: #ff9800; font-size: 10px;">
                "${point}"
              </div>`
            ).join('')}
          </div>
        </div>
      `;
    }
  }
  
  // Stats
  if (insights.stats) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Statistics</div>
        <div class="stat-grid">
          <div class="stat-item">
            <div class="stat-number">${insights.stats.wordCount || 0}</div>
            <div class="stat-label">Words</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">${insights.stats.questions || 0}</div>
            <div class="stat-label">Questions</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">${insights.stats.segments || 0}</div>
            <div class="stat-label">Segments</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">${insights.stats.speakers || 'N/A'}</div>
            <div class="stat-label">Speakers</div>
          </div>
        </div>
      </div>
    `;
  }
  
  // Sentiment
  if (insights.sentiment && insights.sentiment.dominant) {
    const sentiment = insights.sentiment.dominant;
    const sentimentClass = `sentiment-${sentiment}`;
    const sentimentLabel = sentiment === 'positive' ? 'Positive' : sentiment === 'negative' ? 'Negative' : 'Neutral';
    
    html += `
      <div class="insight-card">
        <div class="insight-label">Overall Sentiment</div>
        <div class="insight-value ${sentimentClass}">
          ${sentimentLabel}
        </div>
        <div class="stat-grid" style="margin-top: 5px;">
          <div class="stat-item">
            <div class="stat-number sentiment-positive">${insights.sentiment.breakdown?.positive || 0}</div>
            <div class="stat-label">Positive</div>
          </div>
          <div class="stat-item">
            <div class="stat-number sentiment-neutral">${insights.sentiment.breakdown?.neutral || 0}</div>
            <div class="stat-label">Neutral</div>
          </div>
          <div class="stat-item">
            <div class="stat-number sentiment-negative">${insights.sentiment.breakdown?.negative || 0}</div>
            <div class="stat-label">Negative</div>
          </div>
        </div>
      </div>
    `;
  }
  
  // Key Phrases
  if (insights.keyPhrases && insights.keyPhrases.length > 0) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Key Phrases</div>
        <div class="key-phrases">
          ${insights.keyPhrases.map(phrase => 
            `<span class="phrase-tag">${phrase}</span>`
          ).join('')}
        </div>
      </div>
    `;
  }
  
  // Action Items
  if (insights.actionItems && insights.actionItems.length > 0) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Action Items (${insights.actionItems.length})</div>
        <div class="action-list">
          ${insights.actionItems.map(item => 
            `<div class="action-item">${item}</div>`
          ).join('')}
        </div>
      </div>
    `;
  }
  
  insightsContainer.innerHTML = html;
}

audioPlayer.addEventListener('pause', () => {
  if (!audioPlayer.ended) {
    statusDiv.innerHTML = "Status: Paused";
  }
});

audioPlayer.addEventListener('play', () => {
  statusDiv.innerHTML = "Status: Playing...";
});

// AI Summary button
generateAISummaryBtn.addEventListener('click', () => {
  if (!currentTranscriptText) {
    alert('No transcript available for analysis');
    return;
  }
  
  generateAISummaryBtn.disabled = true;
  generateAISummaryBtn.textContent = 'Analyzing...';
  
  chrome.runtime.sendMessage({
    type: 'GENERATE_AI_SUMMARY',
    transcript: currentTranscriptText
  });
});