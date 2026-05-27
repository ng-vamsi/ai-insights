// popup.js
import { ENV } from './env.js';

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
const transcriptionSection= document.getElementById('transcriptionSection');
const transcriptContainer = document.getElementById('transcriptContainer');
const insightsSection     = document.getElementById('insightsSection');
const insightsContainer   = document.getElementById('insightsContainer');
const questionsContainer  = document.getElementById('questionsContainer');
const deepContainer       = document.getElementById('deepContainer');
const ragContainer        = document.getElementById('ragContainer');
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
let deepgramApiKey = (ENV.DEEPGRAM_API_KEY || '').trim();
let currentTranscriptText = '';
let ragAnswersMap = {}; // Store RAG answers keyed by questionHash
let questionsMap = {}; // Store all detected questions with their data
let pendingLocalQuestionPrefix = ''; // Holds split question starters across transcript chunks
let dismissedQuestionKeys = new Set(); // User-dismissed questions for current recording

function hashQuestionLocal(question) {
  let hash = 0;
  const str = question.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'q_' + Math.abs(hash).toString(36);
}

function formatSourcesForDisplay(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.map((source) => {
    if (typeof source === 'string') return source;
    if (!source || typeof source !== 'object') return '';
    return source.title || source.name || source.source || source.file || source.path || source.url || source.id || JSON.stringify(source);
  }).filter(Boolean);
}

function isLikelyCompleteQuestionLocal(candidate) {
  if (!candidate) return false;

  const normalized = candidate.replace(/[?]+$/g, '').trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;

  const trailingStopWords = new Set([
    'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'about', 'into', 'onto', 'upon', 'as', 'and', 'or', 'but',
    'if', 'how', 'what', 'when', 'where', 'who', 'which', 'whether'
  ]);
  const lastWord = (words[words.length - 1] || '').toLowerCase();
  if (trailingStopWords.has(lastWord)) return false;

  const lowered = normalized.toLowerCase();
  if (lowered === 'what happens' || lowered === 'what happens in the event of') {
    return false;
  }

  return true;
}

function normalizeQuestionText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function areQuestionsMergeable(a, b) {
  const aNorm = normalizeQuestionText(a);
  const bNorm = normalizeQuestionText(b);
  if (!aNorm || !bNorm) return false;
  if (aNorm === bNorm) return true;

  const aWords = aNorm.split(' ');
  const bWords = bNorm.split(' ');
  const aHead = aWords.slice(0, 2).join(' ');
  const bHead = bWords.slice(0, 2).join(' ');
  const sameHead = aHead && bHead && aHead === bHead;

  return sameHead && (aNorm.startsWith(bNorm) || bNorm.startsWith(aNorm));
}

function upsertQuestion(questionText, incoming = {}) {
  const normalized = (questionText || '').trim();
  if (!normalized) return null;

  const textWithMark = normalized.endsWith('?') ? normalized : `${normalized}?`;
  const normalizedKey = normalizeQuestionText(textWithMark);
  if (!normalizedKey || dismissedQuestionKeys.has(normalizedKey)) {
    return null;
  }

  const incomingHash = incoming.hash;
  const newHash = incomingHash || hashQuestionLocal(textWithMark);

  if (questionsMap[newHash]) {
    const existing = questionsMap[newHash];
    // Preserve answer-related fields if they're already set and incoming doesn't have them
    const mergedData = {
      ...existing,
      text: existing.text || textWithMark,
      hash: newHash,
      timestamp: existing.timestamp,
      answerExpanded: incoming.answerExpanded !== undefined
        ? incoming.answerExpanded
        : (existing.answerExpanded !== undefined ? existing.answerExpanded : true)
    };
    
    // Only override answer-related fields if incoming has meaningful values
    if (incoming.answer && incoming.answer.trim().length > 0) {
      mergedData.answer = incoming.answer;
    }
    if (incoming.sources && incoming.sources.length > 0) {
      mergedData.sources = incoming.sources;
    }
    if (incoming.answerReceived !== undefined) {
      mergedData.answerReceived = incoming.answerReceived;
    }
    if (incoming.noAnswerFound !== undefined) {
      mergedData.noAnswerFound = incoming.noAnswerFound;
    }
    if (incoming.error !== undefined) {
      mergedData.error = incoming.error;
    }
    if (incoming.ragTriggered !== undefined) {
      mergedData.ragTriggered = incoming.ragTriggered;
    }
    
    questionsMap[newHash] = mergedData;
    return newHash;
  }

  const existingEntry = Object.values(questionsMap).find((q) => areQuestionsMergeable(q.text, textWithMark));
  if (existingEntry) {
    // Update existing question in place without changing hash or creating a new one
    const existingNorm = normalizeQuestionText(existingEntry.text);
    const shouldUpdateText = normalizedKey.length > existingNorm.length;
    
    // Preserve answer-related fields if they're already set and incoming doesn't have them
    const mergedData = {
      ...existingEntry,
      text: shouldUpdateText ? textWithMark : existingEntry.text,
      hash: existingEntry.hash,
      timestamp: existingEntry.timestamp,
      answerExpanded: incoming.answerExpanded !== undefined
        ? incoming.answerExpanded
        : (existingEntry.answerExpanded !== undefined ? existingEntry.answerExpanded : true)
    };
    
    // Only override answer-related fields if incoming has meaningful values
    if (incoming.answer && incoming.answer.trim().length > 0) {
      mergedData.answer = incoming.answer;
    }
    if (incoming.sources && incoming.sources.length > 0) {
      mergedData.sources = incoming.sources;
    }
    if (incoming.answerReceived !== undefined) {
      mergedData.answerReceived = incoming.answerReceived;
    }
    if (incoming.noAnswerFound !== undefined) {
      mergedData.noAnswerFound = incoming.noAnswerFound;
    }
    if (incoming.error !== undefined) {
      mergedData.error = incoming.error;
    }
    if (incoming.ragTriggered !== undefined) {
      mergedData.ragTriggered = incoming.ragTriggered;
    }
    
    questionsMap[existingEntry.hash] = mergedData;
    return existingEntry.hash;
  }

  questionsMap[newHash] = {
    text: textWithMark,
    hash: newHash,
    timestamp: incoming.timestamp || Date.now(),
    answer: incoming.answer || '',
    sources: incoming.sources || [],
    noAnswerFound: !!incoming.noAnswerFound,
    error: incoming.error || null,
    answerReceived: !!incoming.answerReceived,
    ragTriggered: !!incoming.ragTriggered,
    answerExpanded: incoming.answerExpanded !== undefined ? incoming.answerExpanded : true
  };
  return newHash;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractQuestionsFromTranscriptLocal(text) {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const cleaned = text.replace(/\s+/g, ' ').trim();
  const questions = [];

  const markedQuestions = [...cleaned.matchAll(/[^.?!\n]*\?/g)]
    .map(match => match[0].trim())
    .filter(q => q.length >= 8)
    .filter(isLikelyCompleteQuestionLocal);
  questions.push(...markedQuestions);

  const prefixPattern = /^(who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|am|will|may|might|have|has|had|which)\b/i;
  const intentPatterns = [
    /^i want to know\b/i,
    /^i wanted to know\b/i,
    /^i want to know if\b/i,
    /^i wanted to know if\b/i,
    /^i want to understand\b/i,
    /^i wanted to ask\b/i,
    /^i am curious\b/i,
    /^i'm curious\b/i,
    /^can you tell me\b/i,
    /^could you tell me\b/i,
    /^tell me\b/i
  ];

  const trailingConnector = /\b(if|how|why|what|when|where|who|which|whether|can|could|would|should|is|are|do|does|did|will|may|might|have|has|had)\s*$/i;
  const chunks = cleaned.split(/[.\n!]/).map(c => c.trim()).filter(Boolean);

  // Merge pending split question starter with the first new chunk.
  if (pendingLocalQuestionPrefix && chunks.length > 0) {
    chunks[0] = `${pendingLocalQuestionPrefix} ${chunks[0]}`.replace(/\s+/g, ' ').trim();
    pendingLocalQuestionPrefix = '';
  }

  chunks.forEach(chunk => {
    const looksLikeQuestion = prefixPattern.test(chunk) || intentPatterns.some(pattern => pattern.test(chunk));
    if (looksLikeQuestion && chunk.length >= 8) {
      if (trailingConnector.test(chunk) && !/[.?!]$/.test(chunk)) {
        pendingLocalQuestionPrefix = chunk;
      } else {
        const normalizedChunk = chunk.endsWith('?') ? chunk : `${chunk}?`;
        if (isLikelyCompleteQuestionLocal(normalizedChunk)) {
          questions.push(normalizedChunk);
        }
      }
    }
  });

  // If this raw text is itself an unfinished starter, hold it for next chunk.
  if ((prefixPattern.test(cleaned) || intentPatterns.some(pattern => pattern.test(cleaned))) && trailingConnector.test(cleaned) && !/[.?!]$/.test(cleaned)) {
    pendingLocalQuestionPrefix = cleaned;
  }

  return [...new Set(questions.map(q => q.replace(/\s+/g, ' ').trim()))];
}

function ensureQuestionInUI(question) {
  const normalized = (question || '').trim();
  if (!normalized) return;

  const insertedHash = upsertQuestion(normalized, {
    timestamp: Date.now(),
    answer: '',
    sources: [],
    noAnswerFound: false,
    error: null,
    answerReceived: false,
    ragTriggered: false
  });

  if (insertedHash) {
    displayQuestions();
  }
}

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
  
  // Display latest insights if available
  if (response.liveInsights) {
    console.log('📊 Displaying insights from GET_STATE:', {
      source: response.liveInsights.source,
      hasTopics: !!response.liveInsights.topics,
      allKeys: Object.keys(response.liveInsights)
    });
    displayLiveInsights(response.liveInsights);
  } else {
    console.log('ℹ️ No insights available in GET_STATE response');
  }

  // Fetch detected questions
  chrome.runtime.sendMessage({ type: 'GET_DETECTED_QUESTIONS' }, (questionsResponse) => {
    if (questionsResponse && questionsResponse.questions && questionsResponse.questions.length > 0) {
      questionsResponse.questions.forEach(q => {
        upsertQuestion(q.text, {
          hash: q.hash,
          timestamp: q.timestamp,
          answer: q.answer,
          sources: q.sources,
          noAnswerFound: !!q.noAnswerFound,
          error: q.error || null,
          answerReceived: !!q.answerReceived
        });
      });
      displayQuestions();
    }
  });
});

console.log('✅ Loaded API configuration from env.js');

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
    handleDownloadResponse(message.data);
  }

  if (message.type === 'PLAYBACK_RESPONSE') {
    handlePlaybackResponse(message.data);
  }
  
  if (message.type === 'TRANSCRIPTION_UPDATE') {
    handleTranscription(message.data);
  }
  
  if (message.type === 'TRANSCRIPTION_ERROR') {
    console.error('❌ Transcription error:', message.error);
    statusDiv.textContent = `Status: Transcription error — ${message.error}`;
    transcriptionSection.classList.add('active');
    transcriptContainer.innerHTML = `<div class="transcript-item" style="border-left-color:#ea4335;">Error: ${message.error}</div>`;
    // Scroll only the transcript container to show error, not the main window
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  }
  
  if (message.type === 'INSIGHTS_READY') {
    displayInsights(message.data);
  }
  
  if (message.type === 'LIVE_INSIGHTS_UPDATE') {
    console.log('📨 POPUP RECEIVED LIVE_INSIGHTS_UPDATE message:', {
      hasData: !!message.data,
      source: message.data?.source,
      allKeys: message.data ? Object.keys(message.data) : []
    });
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

  if (message.type === 'RAG_ANSWER_READY') {
    console.log('📚 Received RAG answer:', message.data);
    displayRAGAnswer(message.data);
  }

  if (message.type === 'QUESTIONS_DETECTED') {
    console.log('📋 Received detected questions:', message.data);
    if (message.data && message.data.allQuestions) {
      // Update questionsMap with all detected questions
      message.data.allQuestions.forEach(q => {
        upsertQuestion(q.text, {
          hash: q.hash,
          timestamp: q.timestamp,
          answer: q.answer,
          sources: q.sources,
          noAnswerFound: !!q.noAnswerFound,
          error: q.error || null,
          answerReceived: !!q.answerReceived
        });
      });
      displayQuestions();
    }
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
  try {
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
      console.log('✅ Download started');
    } else {
      const errorMsg = response?.error || 'Download failed - invalid response';
      console.error('❌ Download response invalid:', errorMsg);
      statusDiv.innerHTML = `Status: ${errorMsg}`;
    }
  } catch (err) {
    console.error('❌ Exception in handleDownloadResponse:', err);
    statusDiv.innerHTML = `Status: Download error - ${err.message}`;
  } finally {
    downloadBtn.disabled = false;
  }
}

startBtn.addEventListener('click', async () => {
  // Prevent multiple clicks
  if (isRecording) {
    console.log('Already recording, ignoring click');
    return;
  }
  
  // Check if API key is actually configured
  if (!deepgramApiKey || deepgramApiKey.length < 20) {
    statusDiv.innerHTML = "Status: Missing Deepgram key in env.js";
    console.error('❌ Invalid API key. Length:', deepgramApiKey?.length || 0);
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
  questionsContainer.innerHTML = ''; // Clear previous questions
  questionsMap = {}; // Reset questions map
  dismissedQuestionKeys = new Set(); // Reset dismissed questions for new recording
  pendingLocalQuestionPrefix = ''; // Reset pending split question text
  ragContainer.innerHTML = ''; // Clear previous RAG answers
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
  
  try {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_RECORDING' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('❌ Download message error:', chrome.runtime.lastError);
        statusDiv.innerHTML = `Status: Error - ${chrome.runtime.lastError.message}`;
        downloadBtn.disabled = false;
      }
    });
  } catch (err) {
    console.error('❌ Exception sending download message:', err);
    statusDiv.innerHTML = `Status: Exception - ${err.message}`;
    downloadBtn.disabled = false;
  }
});

playBtn.addEventListener('click', async () => {
  console.log('Play button clicked');
  statusDiv.innerHTML = "Status: Loading audio...";
  playBtn.disabled = true;

  try {
    console.log('Sending GET_RECORDING_BLOB message...');
    chrome.runtime.sendMessage({ type: 'GET_RECORDING_BLOB' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('❌ Playback message error:', chrome.runtime.lastError);
        statusDiv.innerHTML = `Status: Error - ${chrome.runtime.lastError.message}`;
        playBtn.disabled = false;
      }
    });
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
  try {
    if (response && response.success && response.dataUrl) {
      
      if (!audioPlayer) {
        console.error('❌ Audio player element not found');
        statusDiv.innerHTML = "Status: Error - Audio player not available";
        playBtn.disabled = false;
        return;
      }
      
      audioPlayer.src = response.dataUrl;
      audioPlayer.classList.add('active');

      // Wait for audio to be loaded before playing
      audioPlayer.onloadeddata = () => {
        const duration = audioPlayer.duration;
        const durationText = isFinite(duration) ? `${Math.round(duration)}s` : 'Unknown';
        audioPlayer.play()
          .then(() => {
            statusDiv.innerHTML = `Status: Playing... (${durationText})`;
            playBtn.disabled = false;
          })
          .catch(err => {
            console.error('❌ Play error:', err);
            statusDiv.innerHTML = `Status: Play error - ${err.message}`;
            playBtn.disabled = false;
          });
      };

      audioPlayer.onerror = (e) => {
        console.error('❌ Audio element error:', e, audioPlayer.error);
        statusDiv.innerHTML = `Status: Audio error - ${audioPlayer.error?.message || 'Unknown error'}`;
        playBtn.disabled = false;
      };
    } else {
      const errorMsg = response?.error || 'Playback failed - no data';
      console.error('❌ Playback failed:', errorMsg);
      statusDiv.innerHTML = `Status: ${errorMsg}`;
      playBtn.disabled = false;
    }
  } catch (err) {
    console.error('❌ Exception in handlePlaybackResponse:', err);
    statusDiv.innerHTML = `Status: Playback error - ${err.message}`;
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
  // Handle transcription update
  
  const { transcript, is_final, timestamp } = data;
  
  if (!transcript || transcript.trim() === '') {
    console.log('⚠️ Empty transcript, skipping');
    return;
  }

  // Question detection is now handled entirely by background.js with two-stage pending/confirmed system
  // No local extraction here to avoid duplicates or partial questions
  
  // Make sure section is visible
  if (!transcriptionSection.classList.contains('active')) {

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
    
    // Scroll only the transcript container, not the main window
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
    
    // Scroll only the transcript container, not the main window
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  }
}

// Display insights
function displayInsights(insights) {


  insightsSection.classList.add('active');
  switchTab('insights');

  let html = '';

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
  
  // Sentiment with contributing lines
  if (insights.sentiment && insights.sentiment.dominant) {
    const sentiment = insights.sentiment.dominant;
    const sentimentClass = `sentiment-${sentiment}`;
    const sentimentLabel = sentiment === 'positive' ? 'Positive' : sentiment === 'negative' ? 'Negative' : 'Neutral';
    const lines = insights.sentiment.lines || {};
    
    let sentimentHtml = `
      <div class="insight-card">
        <div class="insight-label">Overall Sentiment</div>
        <div class="insight-value ${sentimentClass}">
          ${sentimentLabel}
        </div>
        <div class="stat-grid" style="margin-top: 10px;">
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
    `;
    
    // Add contributing lines for each sentiment
    if (lines.positive && lines.positive.length > 0) {
      sentimentHtml += `
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e0e0e0;">
          <div class="stat-label" style="color: #4caf50; margin-bottom: 5px;">Positive Lines (${lines.positive.length}):</div>
          ${lines.positive.map(line => `
            <div style="font-size: 12px; color: #4caf50; margin: 4px 0; padding: 4px; background: #f1f8f4; border-radius: 3px;">
              "${line}"
            </div>
          `).join('')}
        </div>
      `;
    }
    
    if (lines.negative && lines.negative.length > 0) {
      sentimentHtml += `
        <div style="margin-top: 8px;">
          <div class="stat-label" style="color: #f44336; margin-bottom: 5px;">Negative Lines (${lines.negative.length}):</div>
          ${lines.negative.map(line => `
            <div style="font-size: 12px; color: #f44336; margin: 4px 0; padding: 4px; background: #ffebee; border-radius: 3px;">
              "${line}"
            </div>
          `).join('')}
        </div>
      `;
    }
    
    sentimentHtml += `</div>`;
    html += sentimentHtml;
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
}

function displayRAGAnswer(data) {
  if (!data || !data.question) {
    console.warn('⚠️ Invalid RAG answer data');
    return;
  }

  const { question, questionHash, ragResponse } = data;

  const safeResponse = ragResponse || {
    answer: '',
    sources: [],
    noAnswerFound: true,
    error: 'No related answer found'
  };

  const targetHash = upsertQuestion(question, {
    hash: questionHash,
    answer: safeResponse.answer || '',
    sources: formatSourcesForDisplay(safeResponse.sources || []),
    noAnswerFound: !!safeResponse.noAnswerFound,
    error: safeResponse.error || null,
    answerReceived: true,
    ragTriggered: false,
    answerExpanded: true
  });

  if (!targetHash) {
    return;
  }

  // Refresh the questions display with updated answer
  displayQuestions();
}

function displayQuestions() {
  if (!questionsMap || Object.keys(questionsMap).length === 0) {
    questionsContainer.innerHTML = '';
    return;
  }

  const sortedQuestions = Object.values(questionsMap)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  let html = `
    <div style="font-size: 14px; font-weight: 700; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #ea4335; color: #d32f2f;">
      Questions Asked (${Object.keys(questionsMap).length})
    </div>
  `;

  // Display each question with its answer
  sortedQuestions.forEach((q, idx) => {
    const questionIndex = idx + 1;
    const hasAnswer = !!(q.answer && q.answer.trim().length > 0);
    const hasBeenQueried = q.ragTriggered || q.answerReceived || q.noAnswerFound || q.error;
    const cardBackground = hasAnswer ? '#e8f5e9' : '#ffebee';
    const cardBorder = hasAnswer ? '#2e7d32' : '#c62828';
    const questionColor = hasAnswer ? '#1b5e20' : '#b71c1c';
    const answerExpanded = q.answerExpanded !== false;
    const queryButtonLabel = q.ragTriggered
      ? 'Querying...'
      : ((q.answerReceived || q.noAnswerFound || q.error || hasAnswer) ? 'Ask AI Again' : 'Ask AI');
    const queryButtonDisabled = q.ragTriggered ? 'disabled' : '';
    
    html += `
      <div style="background: ${cardBackground}; border-left: 4px solid ${cardBorder}; padding: 12px; margin: 10px 0; border-radius: 4px; position: relative;">
        <button class="remove-question-btn" data-question-hash="${q.hash}" style="position:absolute; top:8px; right:8px; padding:4px 8px; font-size:11px; border:none; border-radius:3px; background:#ea4335; color:#fff; cursor:pointer; font-weight:600;">Delete</button>
        <div style="font-size: 13px; font-weight: 500; color: ${questionColor}; margin-bottom: 8px;">
          Q${questionIndex}: ${hasBeenQueried ? q.text : ''}
        </div>
    `;
    
    if (!hasBeenQueried) {
      html += `
        <textarea class="question-edit-input" data-question-hash="${q.hash}" style="width:100%; min-height:56px; resize:vertical; border:1px solid #d0d7de; border-radius:4px; padding:8px; font-size:12px; color:#202124; box-sizing:border-box;">${escapeHtml(q.text)}</textarea>
        <div style="font-size:11px; color:#5f6368; margin-top:4px; margin-bottom:8px;">You can edit this question before querying RAG.</div>
      `;
    }
    
    html += `
        <div style="font-size: 12px; color: #5f6368; margin-left: 12px;">
    `;

    // RAG response block
    html += `<div style="background: #eef3ff; padding: 8px; border-radius: 4px; margin-bottom: 8px; border-left: 3px solid #3367d6;">`;
    // html += `<div style="font-size: 11px; font-weight: 700; color: #1a3f9d; margin-bottom: 4px;">RAG (/rag/query)</div>`;
    if (q.answer && q.answer.trim().length > 0) {
      const toggleLabel = answerExpanded ? 'Minimize Answer' : 'Expand Answer';
      html += `<div style="margin-bottom: 6px;"><button class="toggle-answer-btn" data-question-hash="${q.hash}" style="padding: 4px 8px; font-size: 11px; background:#1b5e20; color:#fff; border:none; border-radius:3px; cursor:pointer;">${toggleLabel}</button></div>`;
      if (answerExpanded) {
        const formattedAnswer = renderMarkdown(q.answer);
        html += `<div style="color:#202124; line-height:1.6;">${formattedAnswer}</div>`;
      } else {
        html += `<div style="color:#5f6368; font-style: italic;">Answer minimized</div>`;
      }
      if (answerExpanded && q.sources && q.sources.length > 0) {
        html += `<div style="font-size: 11px; color: #5f6368; margin-top: 6px;"><strong>Sources:</strong> ${formatSourcesForDisplay(q.sources).slice(0, 2).join(', ')}</div>`;
      }
    } else if (q.noAnswerFound || q.error) {
      const ragReason = q.error || 'No related answer found in knowledge base';
      html += `<div style="color:#8d6e63;"><strong>No answer found:</strong> ${ragReason}</div>`;
    } else if (!q.ragTriggered) {
      // Only show this message if RAG hasn't been triggered yet
      // After clicking the button, ragTriggered will be true and this won't show
    }

    html += `<div style="margin-top: 8px;"><button class="ask-rag-btn" data-question-hash="${q.hash}" ${queryButtonDisabled} style="padding: 6px 10px; font-size: 12px; background:#3367d6; color:#fff; border:none; border-radius:4px; cursor:pointer;">${queryButtonLabel}</button></div>`;
    html += `</div>`;

    html += `
        </div>
      </div>
    `;
  });

  questionsContainer.innerHTML = html;
}

questionsContainer.addEventListener('click', (event) => {
  const removeBtn = event.target.closest('.remove-question-btn');
  if (removeBtn) {
    const questionHashToRemove = removeBtn.getAttribute('data-question-hash');
    const questionItemToRemove = questionsMap[questionHashToRemove];
    if (questionItemToRemove) {
      dismissedQuestionKeys.add(normalizeQuestionText(questionItemToRemove.text));
      delete questionsMap[questionHashToRemove];
      displayQuestions();
    }
    return;
  }

  const toggleBtn = event.target.closest('.toggle-answer-btn');
  if (toggleBtn) {
    const questionHashToToggle = toggleBtn.getAttribute('data-question-hash');
    const questionItemToToggle = questionsMap[questionHashToToggle];
    if (questionItemToToggle) {
      questionItemToToggle.answerExpanded = questionItemToToggle.answerExpanded === false;
      displayQuestions();
    }
    return;
  }

  const button = event.target.closest('.ask-rag-btn');
  if (!button) return;

  const questionHash = button.getAttribute('data-question-hash');
  const questionInput = questionsContainer.querySelector(`.question-edit-input[data-question-hash="${questionHash}"]`);
  const editedText = (questionInput ? questionInput.value : '').trim();
  const questionItem = questionsMap[questionHash];
  if (!questionItem || !questionItem.text) return;

  const normalizedQuestionText = (editedText || questionItem.text || '').trim();
  if (!normalizedQuestionText) return;
  const normalizedQuestionWithMark = normalizedQuestionText.endsWith('?') ? normalizedQuestionText : `${normalizedQuestionText}?`;

  // Update the question in place without creating a new one
  const activeQuestion = questionItem;
  activeQuestion.text = normalizedQuestionWithMark;

  // Re-query should reset the card to pending (red) until a valid answer arrives.
  activeQuestion.ragTriggered = true;
  activeQuestion.noAnswerFound = false;
  activeQuestion.error = null;
  activeQuestion.answer = '';
  activeQuestion.sources = [];
  activeQuestion.answerReceived = false;
  activeQuestion.answerExpanded = true;
  displayQuestions();

  chrome.runtime.sendMessage({
    type: 'QUERY_RAG_QUESTION',
    question: normalizedQuestionWithMark
  });
});

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
  
  // Show source indicator and latency for LLM insights
  if (insights.source === 'llm') {
    html += `
      <div class="insight-card" style="background:#f0f4ff; border-left:4px solid #4285f4;">
        <div class="insight-label">AI Insights (OpenAI)</div>
        <div class="insight-value" style="font-size:13px; color:#1a73e8;">
          Real-time analysis ${insights.latencyMs ? `(${insights.latencyMs}ms)` : ''}
        </div>
      </div>
    `;
  }

  // Handle new LLM format (refined insights with customer intent analysis)
  if (insights.source === 'llm') {
    // Competitor Risk
    if (insights.competitorRisk) {
      const compColor = insights.competitorRisk === 'high' ? '#ea4335' : insights.competitorRisk === 'medium' ? '#ff9800' : '#4caf50';
      const compLabel = insights.competitorRisk === 'high' ? 'COMPETING' : insights.competitorRisk === 'medium' ? 'EVALUATING' : 'EXCLUSIVE';
      html += `
        <div class="insight-card" style="border-left: 4px solid ${compColor};">
          <div class="insight-label">${compLabel}</div>
          <div class="insight-value" style="color: ${compColor}; font-size: 12px;">
            Competitor/alternative risk: ${insights.competitorRisk.toUpperCase()}
          </div>
        </div>
      `;
    }

    // Customer Needs (underlying problems they're trying to solve)
    if (insights.customerNeeds && insights.customerNeeds.length > 0) {
      html += `
        <div class="insight-card" style="border-left: 4px solid #2196f3;">
          <div class="insight-label">What They Really Need</div>
          <div class="need-list">
            ${insights.customerNeeds.map(need => {
              const cleanNeed = need.replace(/[^\x00-\x7F]/g, '').trim();
              return `
              <div style="padding: 8px; background: #e3f2fd; margin: 6px 0; border-radius: 4px; font-size: 13px; color: #1565c0;">
                - ${cleanNeed}
              </div>
            `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // Decision Criteria (what matters to them based on questions)
    if (insights.decisionCriteria && insights.decisionCriteria.length > 0) {
      html += `
        <div class="insight-card" style="border-left: 4px solid #9c27b0;">
          <div class="insight-label">How They'll Decide</div>
          <div class="criteria-list">
            ${insights.decisionCriteria.map(criterion => {
              const cleanCriterion = criterion.replace(/[^\x00-\x7F]/g, '').trim();
              return `
              <div style="padding: 8px; background: #f3e5f5; margin: 6px 0; border-radius: 4px; font-size: 13px; color: #6a1b9a;">
                - ${cleanCriterion}
              </div>
            `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // Hidden Objections (unstated concerns implied by questions)
    if (insights.hiddenObjections && insights.hiddenObjections.length > 0) {
      html += `
        <div class="insight-card" style="border-left: 4px solid #f57c00;">
          <div class="insight-label">Hidden Concerns (unstated)</div>
          <div class="hidden-objection-list">
            ${insights.hiddenObjections.map(concern => `
              <div style="padding: 8px; background: #ffe0b2; margin: 6px 0; border-radius: 4px; font-size: 13px; color: #e65100;">
                - ${concern}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Risk Level with context
    if (insights.riskLevel) {
      const riskColor = insights.riskLevel === 'high' ? '#d32f2f' : insights.riskLevel === 'medium' ? '#f57c00' : '#388e3c';
      html += `
        <div class="insight-card" style="border-left: 4px solid ${riskColor};">
          <div class="insight-label">Deal Risk</div>
          <div class="insight-value" style="color: ${riskColor}; text-transform: uppercase; font-weight: bold; font-size: 14px;">
            ${insights.riskLevel}
          </div>
        </div>
      `;
    }

    // Sentiment
    if (insights.sentiment) {
      const sentimentMap = {
        positive: { label: 'Positive', color: '#4caf50' },
        skeptical: { label: 'Skeptical', color: '#ff9800' },
        anxious: { label: 'Anxious', color: '#ea4335' },
        indifferent: { label: 'Indifferent', color: '#9e9e9e' },
        neutral: { label: 'Neutral', color: '#9e9e9e' }
      };
      const sent = sentimentMap[insights.sentiment] || sentimentMap.neutral;
      html += `
        <div class="insight-card">
          <div class="insight-label">Emotion</div>
          <div class="insight-value" style="color: ${sent.color}; font-weight: 500;">
            ${sent.label}
          </div>
        </div>
      `;
    }

    // IMMEDIATE ACTION (top priority)
    if (insights.immediateAction) {
      html += `
        <div class="insight-card" style="border-left: 4px solid #d32f2f; background: #ffebee;">
          <div class="insight-label">ACT NOW</div>
          <div style="padding: 12px; background: white; border-radius: 4px; font-size: 13px; line-height: 1.7; font-weight: 500; color: #c62828;">
            ${insights.immediateAction}
          </div>
        </div>
      `;
    }
  } else {
    // Old format (rule-based generateLiveInsights) - keep existing display code
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

    // Sentiment with contributing lines
    if (insights.sentiment && insights.sentiment.dominant) {
      const sentiment = insights.sentiment.dominant;
      const sentimentClass = `sentiment-${sentiment}`;
      const sentimentLabel = sentiment === 'positive' ? 'Positive' : sentiment === 'negative' ? 'Negative' : 'Neutral';
      const lines = insights.sentiment.lines || {};

      let sentimentHtml = `
        <div class="insight-card">
          <div class="insight-label">Overall Sentiment</div>
          <div class="insight-value ${sentimentClass}">
            ${sentimentLabel}
          </div>
          <div class="stat-grid" style="margin-top: 10px;">
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
      `;
      
      // Add contributing lines for each sentiment
      if (lines.positive && lines.positive.length > 0) {
        sentimentHtml += `
          <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e0e0e0;">
            <div class="stat-label" style="color: #4caf50; margin-bottom: 5px;">Positive Lines (${lines.positive.length}):</div>
            ${lines.positive.map(line => `
              <div style="font-size: 12px; color: #4caf50; margin: 4px 0; padding: 4px; background: #f1f8f4; border-radius: 3px;">
                "${line}"
              </div>
            `).join('')}
          </div>
        `;
      }
      
      if (lines.negative && lines.negative.length > 0) {
        sentimentHtml += `
          <div style="margin-top: 8px;">
            <div class="stat-label" style="color: #f44336; margin-bottom: 5px;">Negative Lines (${lines.negative.length}):</div>
            ${lines.negative.map(line => `
              <div style="font-size: 12px; color: #f44336; margin: 4px 0; padding: 4px; background: #ffebee; border-radius: 3px;">
                "${line}"
              </div>
            `).join('')}
          </div>
        `;
      }
      
      sentimentHtml += `</div>`;
      html += sentimentHtml;
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