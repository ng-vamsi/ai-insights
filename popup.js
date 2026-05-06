// popup.js
const startBtn            = document.getElementById('startBtn');
const stopBtn             = document.getElementById('stopBtn');
const downloadBtn         = document.getElementById('downloadBtn');
const playBtn             = document.getElementById('playBtn');
const statusDiv           = document.getElementById('status');
const statsDiv            = document.getElementById('stats');
const durationSpan        = document.getElementById('duration');
const chunksSpan          = document.getElementById('chunks');
const sizeSpan            = document.getElementById('size');
const audioPlayer         = document.getElementById('audioPlayer');
const apiKeyInput         = document.getElementById('apiKeyInput');
const saveApiKeyBtn       = document.getElementById('saveApiKeyBtn');
const openaiKeyInput      = document.getElementById('openaiKeyInput');
const saveOpenaiKeyBtn    = document.getElementById('saveOpenaiKeyBtn');
const apiKeySection       = document.getElementById('apiKeySection');
const transcriptionSection= document.getElementById('transcriptionSection');
const transcriptContainer = document.getElementById('transcriptContainer');
const insightsSection     = document.getElementById('insightsSection');
const insightsContainer   = document.getElementById('insightsContainer');
const deepContainer       = document.getElementById('deepContainer');
const generateAISummaryBtn= document.getElementById('generateAISummaryBtn');
const tabInsights         = document.getElementById('tabInsights');
const tabDeep             = document.getElementById('tabDeep');
const insightsPanel       = document.getElementById('insightsPanel');
const deepPanel           = document.getElementById('deepPanel');

// ── Tab switching ────────────────────────────────────────
function switchTab(tab) {
  const toInsights = tab === 'insights';
  tabInsights.classList.toggle('active', toInsights);
  tabDeep.classList.toggle('active', !toInsights);
  insightsPanel.classList.toggle('active', toInsights);
  deepPanel.classList.toggle('active', !toInsights);
}
tabInsights.addEventListener('click', () => switchTab('insights'));
tabDeep.addEventListener('click',     () => switchTab('deep'));

let isRecording = false;
let deepgramApiKey = null;
let currentTranscriptText = '';
let apiKeysLoaded = false; // Track if storage has been loaded

// ── Restore UI state when popup reopens ─────────────────
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError || !response) return;

  if (response.isRecording) {
    isRecording = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statsDiv.classList.add('active');
    transcriptionSection.classList.add('active');
    insightsSection.classList.add('active');
    statusDiv.innerHTML = "Status: <span class='recording'>RECORDING...</span>";
  } else if (response.hasRecording) {
    downloadBtn.disabled = false;
    playBtn.disabled = false;
    statusDiv.textContent = `Status: Recording ready (${response.duration}s) — download or play below`;
  }
});

// Load API key on startup (MUST complete before recording can start)
chrome.storage.local.get(['deepgramApiKey', 'openaiApiKey'], (result) => {
  if (result.deepgramApiKey) {
    deepgramApiKey = result.deepgramApiKey;
    console.log('✅ Deepgram API key loaded from storage, length:', deepgramApiKey.length);
    apiKeyInput.value = '••••••••••••';
    apiKeyInput.disabled = true;
    apiKeySection.classList.add('configured');
    saveApiKeyBtn.textContent = 'Change';
  } else {
    console.warn('⚠️ No Deepgram API key found in storage');
  }
  
  if (result.openaiApiKey) {
    openaiKeyInput.value = '••••••••••••';
    openaiKeyInput.disabled = true;
    saveOpenaiKeyBtn.textContent = 'Change';
  }
  
  // Mark that API keys have been loaded
  apiKeysLoaded = true;
  console.log('✅ API keys loading complete');
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
  
  if (message.type === 'DOWNLOAD_RESPONSE') {
    console.log('✅ Received download response:', message.data);
    handleDownloadResponse(message.data);
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
    statusDiv.textContent = `Status: Transcription error — ${message.error}`;
    transcriptionSection.classList.add('active');
    transcriptContainer.innerHTML = `<div class="transcript-item" style="border-left-color:#ea4335;">Error: ${message.error}</div>`;
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
    generateAISummaryBtn.textContent = 'Generate Deep Analysis';
    deepContainer.innerHTML = `
      <div class="deep-placeholder" style="color:#ea4335;">
        <p>Error: ${message.error}</p>
      </div>`;
    switchTab('deep');
  }
});

function handleStopResponse(response) {
  isRecording = false;

  if (response && response.success) {
    statusDiv.innerHTML = `Status: Recording saved — <strong>${response.duration}s</strong>. Ready to download or play.`;
    startBtn.disabled = false;
    downloadBtn.disabled = false;
    playBtn.disabled = false;
  } else {
    statusDiv.textContent = 'Status: Error stopping recording — try again';
    startBtn.disabled = false;
  }
}

function handleDownloadResponse(response) {
  if (response && response.success && response.dataUrl) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = response.dataUrl;
    a.download = `recording-${timestamp}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    const sizeMB = (response.size / 1024 / 1024).toFixed(2);
    statusDiv.innerHTML = `Status: Download started (${sizeMB} MB)`;
    console.log('Download initiated successfully');
  } else {
    statusDiv.innerHTML = `Status: ${response?.error || 'Download failed'}`;
  }
  downloadBtn.disabled = false;
}

startBtn.addEventListener('click', async () => {
  // Prevent multiple clicks
  if (isRecording) {
    console.log('Already recording, ignoring click');
    return;
  }
  
  // Wait for API keys to load from storage (max 2 seconds)
  if (!apiKeysLoaded) {
    console.log('⏳ Waiting for API keys to load from storage...');
    statusDiv.innerHTML = "Status: Loading API keys...";
    startBtn.disabled = true;
    
    // Wait up to 2 seconds for API keys to load
    let waited = 0;
    while (!apiKeysLoaded && waited < 2000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waited += 100;
    }
    
    if (!apiKeysLoaded) {
      console.error('❌ API keys failed to load from storage');
      statusDiv.innerHTML = "Status: Failed to load API keys";
      startBtn.disabled = false;
      return;
    }
  }
  
  // Check if API key is actually configured
  if (!deepgramApiKey || deepgramApiKey.length < 20) {
    statusDiv.innerHTML = "Status: Please configure a valid Deepgram API key first";
    console.error('❌ Invalid API key. Length:', deepgramApiKey?.length || 0);
    apiKeyInput.focus();
    startBtn.disabled = false;
    return;
  }

  // 1. Get the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    statusDiv.textContent = "Error: No active tab found.";
    startBtn.disabled = false;
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
  console.log('📤 Sending INIT_RECORDING with API key length:', deepgramApiKey.length);
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
  statusDiv.textContent = 'Status: Stopping — generating insights...';
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

downloadBtn.addEventListener('click', () => {
  console.log('Download button clicked');
  statusDiv.innerHTML = "Status: Preparing download...";
  downloadBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_RECORDING' });
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

// ── Sales Coach renderer ─────────────────────────────────
function renderSalesCoach(coach) {
  if (!coach) return '';

  const riskHtml = coach.riskFactors && coach.riskFactors.length > 0 ? `
    <div class="coach-section">
      <div class="coach-section-title">Risk Factors</div>
      ${coach.riskFactors.map(r => `<div class="coach-bullet risk">- ${r}</div>`).join('')}
    </div>` : '';

  const oppHtml = coach.opportunities && coach.opportunities.length > 0 ? `
    <div class="coach-section">
      <div class="coach-section-title">Opportunities</div>
      ${coach.opportunities.map(o => `<div class="coach-bullet opp">+ ${o}</div>`).join('')}
    </div>` : '';

  return `
    <div class="sales-coach-card">
      <div class="coach-header">Sales Coach</div>
      <div class="intent-badge" style="color:${coach.intentColor}; border-color:${coach.intentColor}; background:${coach.intentColor}18;">
        ${coach.intentLabel}
      </div>
      <div class="coach-next-action">
        <div class="coach-label">Next Best Action</div>
        ${coach.nextAction}
      </div>
      <div class="coach-tip">${coach.coachingTip}</div>
      ${riskHtml}
      ${oppHtml}
    </div>
  `;
}

// Display insights
function displayInsights(insights) {
  console.log('📊 Displaying insights:', insights);

  insightsSection.classList.add('active');
  switchTab('insights');

  let html = '';

  // Sales Coach — always first
  html += renderSalesCoach(insights.salesCoach);

  // Latency display
  if (typeof insights.latencyMs === 'number') {
    html += `
      <div class="insight-card" style="background:#f5f5f5; border-left:3px solid #607d8b;">
        <div class="insight-label">Insight Latency</div>
        <div class="insight-value" style="font-size:13px; color:#607d8b;">${insights.latencyMs} ms</div>
      </div>
    `;
  }

  // Summary
  if (insights.summary) {
    html += `
      <div class="insight-card">
        <div class="insight-label">Call Summary</div>
        <div class="insight-value">${insights.summary}</div>
      </div>
    `;
  }

  // Customer questions
  if (insights.customerQuestions && insights.customerQuestions.length > 0) {
    html += `
      <div class="insight-card" style="border-left: 3px solid #4285f4;">
        <div class="insight-label">
          Questions Asked by Customer
          <span class="card-count">${insights.customerQuestions.length}</span>
        </div>
        <div class="question-list">
          ${insights.customerQuestions.map((q, i) => `
            <div class="question-item">
              <span class="question-num">Q${i + 1}</span>
              <span>${q}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Customer doubts / concerns
  if (insights.customerDoubts && insights.customerDoubts.length > 0) {
    html += `
      <div class="insight-card" style="background: #fff8f0; border-left: 3px solid #fb8c00;">
        <div class="insight-label">
          Doubts &amp; Concerns Raised
          <span class="card-count" style="background:#fb8c00;">${insights.customerDoubts.length}</span>
        </div>
        <div class="doubt-list">
          ${insights.customerDoubts.map(d => `
            <div class="doubt-item">
              <span class="doubt-icon">!</span>
              <span>${d}</span>
            </div>
          `).join('')}
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
      <div class="insight-card" style="border-left: 3px solid #34a853;">
        <div class="insight-label">
          Action Items
          <span class="card-count" style="background:#34a853;">${insights.actionItems.length}</span>
        </div>
        <div class="action-list">
          ${insights.actionItems.map(item =>
            `<div class="action-item"><span class="action-check">[ ]</span><span>${item}</span></div>`
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

function renderMarkdown(text) {
  return text
    // Normalize line endings (OpenAI may return \r\n)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    // HTML-escape only the raw text characters
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Headings first (## and ###), before bold so ## **HEADING** works
    .replace(/^#{3,} (.+)$/gm, '<div class="ai-sub-head">$1</div>')
    .replace(/^## (.+)$/gm, '<div class="ai-section-head">$1</div>')
    // Bold and italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    // Bullet lists (-, *, •)
    .replace(/^[\-\*•] (.+)$/gm, '<div class="ai-bullet">• $1</div>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, (_, p) => `<div class="ai-numbered">${p}</div>`)
    // Strip any remaining unmatched markdown symbols
    .replace(/\*+/g, '').replace(/^#+\s*/gm, '').replace(/__/g, '')
    // Newlines to breaks
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

// Display AI-generated summary in the Deep Analysis tab
function displayAISummary(summary) {
  generateAISummaryBtn.disabled = false;
  generateAISummaryBtn.textContent = 'Regenerate';

  deepContainer.innerHTML = `<div class="ai-summary-card">${renderMarkdown(summary)}</div>`;

  switchTab('deep');
}

// Display live insights during recording
function displayLiveInsights(insights) {
  if (!insights) return;

  let html = '';

  // Sales Coach — always first
  html += renderSalesCoach(insights.salesCoach);

  // Latency
  if (typeof insights.latencyMs === 'number') {
    html += `
      <div class="insight-card" style="background:#f5f5f5; border-left:3px solid #607d8b;">
        <div class="insight-label">Insight Latency</div>
        <div class="insight-value" style="font-size:13px; color:#607d8b;">${insights.latencyMs} ms</div>
      </div>
    `;
  }
  
  // Customer Questions (live)
  if (insights.customerQuestions && insights.customerQuestions.length > 0) {
    html += `
      <div class="insight-card" style="border-left: 3px solid #4285f4;">
        <div class="insight-label">
          Questions Asked So Far
          <span class="card-count">${insights.customerQuestions.length}</span>
        </div>
        <div class="question-list">
          ${insights.customerQuestions.map((q, i) => `
            <div class="question-item">
              <span class="question-num">Q${i + 1}</span>
              <span>${q}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Customer Doubts (live)
  if (insights.customerDoubts && insights.customerDoubts.length > 0) {
    html += `
      <div class="insight-card" style="background: #fff8f0; border-left: 3px solid #fb8c00;">
        <div class="insight-label">
          Doubts &amp; Concerns
          <span class="card-count" style="background:#fb8c00;">${insights.customerDoubts.length}</span>
        </div>
        <div class="doubt-list">
          ${insights.customerDoubts.map(d => `
            <div class="doubt-item">
              <span class="doubt-icon">!</span>
              <span>${d}</span>
            </div>
          `).join('')}
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
      <div class="insight-card" style="border-left: 3px solid #34a853;">
        <div class="insight-label">
          Action Items
          <span class="card-count" style="background:#34a853;">${insights.actionItems.length}</span>
        </div>
        <div class="action-list">
          ${insights.actionItems.map(item =>
            `<div class="action-item"><span class="action-check">[ ]</span><span>${item}</span></div>`
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
    deepContainer.innerHTML = `
      <div class="deep-placeholder">
        <p>No transcript yet. Record a call and stop it first, then come back here.</p>
      </div>`;
    return;
  }

  generateAISummaryBtn.disabled = true;
  generateAISummaryBtn.textContent = 'Analyzing...';
  deepContainer.innerHTML = `
    <div class="deep-placeholder" style="color:#4285f4;">
      <p>Generating AI analysis — this may take a few seconds...</p>
    </div>`;

  chrome.runtime.sendMessage({
    type: 'GENERATE_AI_SUMMARY',
    transcript: currentTranscriptText
  });
});