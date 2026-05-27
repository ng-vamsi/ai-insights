// background.js
import { ENV } from './env.js';

console.log('🚀 Background service worker loaded');

// Storage for audio recording
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTabId = null;
let deepgramApiKey = (ENV.DEEPGRAM_API_KEY || '').trim();
let deepgramSocket = null;
let deepgramConnected = false;

// Storage for transcripts and insights
let fullTranscript = [];
let sentimentData = [];
let detectedTopics = [];
let detectedIntents = [];

// LLM Configuration for real-time insights - using OpenAI directly
let openaiApiKey = (ENV.OPENROUTER_API_KEY || '').trim();
let lastInsightGenerationTime = 0;
const INSIGHT_GENERATION_INTERVAL = 10000; // Generate insights every 10 seconds (batch for cost efficiency)

// Load API keys from storage on startup
chrome.storage.local.get(['openaiApiKey', 'deepgramApiKey'], (result) => {
  if (result.openaiApiKey) {
    openaiApiKey = result.openaiApiKey;
    console.log('🔑 OpenAI API key loaded from storage');
  }
  if (result.deepgramApiKey) {
    deepgramApiKey = result.deepgramApiKey;
    console.log('🔑 Deepgram API key loaded from storage');
  }
});

// RAG Configuration for document search
let ragBaseUrl = (ENV.RAG_BASE_URL || 'http://localhost:8000').trim();
const RAG_QUERY_TIMEOUT_MS = 300000; // Wait up to 5 minutes for local RAG backend responses
let processedQuestions = new Set(); // Track which questions we've already queried
let ragAnswers = {}; // Store answers keyed by question hash
let detectedQuestions = []; // Store all questions detected in conversation with their hashes
let pendingQuestionPrefix = ''; // Holds split question starters across transcript chunks

// Two-stage question detection: pending → confirmed
let pendingCandidates = {}; // { candidateHash: { text, firstSeenAt, lastUpdatedAt, confidence, extendCount } }
const STABILITY_WINDOW_MS = 1500; // Hold candidate for 1.5s before confirming
const CONFIDENCE_THRESHOLD = 0.6; // Score 0-1; >= threshold = auto-confirm
const AI_VALIDATION_THRESHOLD = 0.4; // 0.4-0.6 = ambiguous, send to AI

function normalizeSourceList(sources) {
  if (!Array.isArray(sources)) {
    return [];
  }

  return sources.map((source) => {
    if (typeof source === 'string') {
      return source;
    }

    if (!source || typeof source !== 'object') {
      return '';
    }

    return source.title || source.name || source.source || source.file || source.path || source.url || source.id || JSON.stringify(source);
  }).filter(Boolean);
}

function scoreQuestionConfidence(candidate) {
  // Returns 0-1 confidence score; higher = more likely complete question
  if (!candidate) return 0;

  const normalized = candidate.replace(/[?]+$/g, '').trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  let score = 0;

  // Word count: 4 is min, 6+ is strong
  if (words.length < 4) return 0;
  score += Math.min(0.2, (words.length - 4) / 10); // Up to 0.2 for word count

  // Ends with question mark: strong signal
  if (candidate.endsWith('?')) score += 0.25;

  // Starts with interrogative or intent pattern
  const interrogatives = /^(who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|am|will|may|might|have|has|had|which)\b/i;
  const intents = /^(i want to know|i wanted to know|i want to understand|can you tell me|tell me|i'm curious|i am curious)/i;
  if (interrogatives.test(normalized) || intents.test(normalized)) score += 0.2;

  // Contains verb-like token
  const verbLike = /\b(is|are|am|was|were|has|have|had|do|does|did|will|would|could|can|should|may|might|use|work|think|know|understand|tell|ask|need|want|make|get|go|come|see|take|give|find|show|say)\b/i;
  if (verbLike.test(normalized)) score += 0.25;

  // Penalty: ends with stop word
  const lastWord = (words[words.length - 1] || '').toLowerCase();
  const stopWords = new Set(['of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'about', 'into', 'onto', 'upon', 'if', 'how', 'what', 'when', 'where', 'who', 'which', 'whether']);
  if (stopWords.has(lastWord)) score -= 0.3;

  // Penalty: known incomplete stems
  const lowered = normalized.toLowerCase();
  if (lowered === 'what happens' || lowered === 'what happens in the event of' || lowered === 'can you tell me if') score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

function isLikelyCompleteQuestion(candidate) {
  // Strict local-only check: requires high confidence or explicit question mark
  const score = scoreQuestionConfidence(candidate);
  return score >= CONFIDENCE_THRESHOLD || candidate.trim().endsWith('?');
}

function hashCandidate(text) {
  let hash = 0;
  const str = (text || '').toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'cand_' + Math.abs(hash).toString(36);
}

// Async AI validator for ambiguous candidates
async function validateQuestionWithAI(candidate) {
  const apiKey = openaiApiKey;
  
  if (!apiKey) {
    console.log('⚠️ OpenRouter API key not configured, skipping AI validation');
    return { isQuestion: true, cleanedText: candidate };
  }
  
  try {
    const response = await fetch(LLM_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a question validator. Respond ONLY with JSON: {\"isQuestion\": boolean, \"cleanedText\": \"string\"}'
          },
          {
            role: 'user',
            content: `Is this a complete question? \"${candidate}\"`
          }
        ],
        temperature: 0,
        max_tokens: 50
      })
    });
    
    if (!response.ok) {
      console.warn('⚠️ AI validation failed:', response.status);
      return { isQuestion: true, cleanedText: candidate };
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return parsed;
  } catch (err) {
    console.error('❌ AI validation exception:', err.message);
    return { isQuestion: true, cleanedText: candidate };
  }
}

// Confirm pending candidates that have reached stability window
async function confirmPendingCandidates() {
  const now = Date.now();
  const newlyConfirmed = [];
  
  for (const [hash, candidate] of Object.entries(pendingCandidates)) {
    const age = now - candidate.firstSeenAt;
    const stability = now - candidate.lastUpdatedAt;
    
    // Confirm if: stable for window OR high confidence
    const shouldConfirm = stability >= STABILITY_WINDOW_MS || candidate.confidence >= CONFIDENCE_THRESHOLD;
    
    if (shouldConfirm) {
      // If mid-band confidence, optionally validate with AI
      if (candidate.confidence >= AI_VALIDATION_THRESHOLD && candidate.confidence < CONFIDENCE_THRESHOLD) {
        console.log('🔄 Ambiguous candidate, validating with AI:', candidate.text);
        const validation = await validateQuestionWithAI(candidate.text);
        if (!validation.isQuestion) {
          console.log('❌ AI rejected:', candidate.text);
          delete pendingCandidates[hash];
          continue;
        }
        candidate.text = validation.cleanedText || candidate.text;
      }
      
      const newQuestion = {
        text: candidate.text.endsWith('?') ? candidate.text : `${candidate.text}?`,
        hash: hashQuestion(candidate.text),
        timestamp: Date.now(),
        answer: null,
        sources: [],
        noAnswerFound: false,
        error: null,
        answerReceived: false
      };
      
      // Check if this question already exists
      const exists = detectedQuestions.some(q => q.hash === newQuestion.hash);
      if (!exists) {
        detectedQuestions.push(newQuestion);
        newlyConfirmed.push(newQuestion);
        console.log('✅ Confirmed question:', newQuestion.text);
      }
      
      delete pendingCandidates[hash];
    }
  }
  
  // Broadcast newly confirmed questions
  if (newlyConfirmed.length > 0) {
    chrome.runtime.sendMessage({
      type: 'QUESTIONS_DETECTED',
      data: {
        questions: newlyConfirmed,
        allQuestions: detectedQuestions.map(q => ({
          text: q.text,
          hash: q.hash,
          timestamp: q.timestamp,
          answer: q.answer,
          sources: q.sources || [],
          noAnswerFound: !!q.noAnswerFound,
          error: q.error || null,
          answerReceived: !!q.answerReceived
        }))
      }
    }).catch(() => {});
  }
}

// Periodically confirm pending candidates (every 500ms)
setInterval(confirmPendingCandidates, 500);

console.log('🔧 API config loaded from env.js');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    
    console.log('📨 Message received in background.js:', message )

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

  // Handle download request — response sent via DOWNLOAD_RESPONSE message
  if (message.type === 'DOWNLOAD_RECORDING') {
    handleDownloadRecording();
    return false;
  }

  // Handle playback request — response sent via PLAYBACK_RESPONSE message
  if (message.type === 'GET_RECORDING_BLOB') {
    handleGetRecordingBlob();
    return false;
  }
  
  // Handle AI summary generation request
  if (message.type === 'GENERATE_AI_SUMMARY') {
    handleGenerateAISummary(message.transcript);
    return false;
  }

  // Return current recording state so popup can restore UI after reopen
  if (message.type === 'GET_STATE') {
    sendResponse({
      isRecording,
      hasRecording: audioChunks.length > 0,
      duration: recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0
    });
    return true;
  }

  // Get all detected questions
  if (message.type === 'GET_DETECTED_QUESTIONS') {
    sendResponse({
      questions: detectedQuestions.map(q => ({
        text: q.text,
        hash: q.hash,
        timestamp: q.timestamp,
        answer: q.answer,
        sources: q.sources,
        noAnswerFound: !!q.noAnswerFound,
        error: q.error || null,
        answerReceived: q.answerReceived || false
      }))
    });
    return true;
  }

  // Direct question trigger from popup fallback detection
  if (message.type === 'QUERY_RAG_QUESTION') {
    const rawQuestion = (message.question || '').trim();
    if (!rawQuestion) {
      return false;
    }

    const normalizedQuestion = rawQuestion.endsWith('?') ? rawQuestion : `${rawQuestion}?`;
    const questionHash = hashQuestion(normalizedQuestion);
    
    // Clear cache for this question to allow fresh retry
    processedQuestions.delete(questionHash);
    delete ragAnswers[questionHash];
    
    const existingQuestion = detectedQuestions.find(q => q.hash === questionHash);

    if (!existingQuestion) {
      detectedQuestions.push({
        text: normalizedQuestion,
        hash: questionHash,
        timestamp: Date.now(),
        answer: null,
        sources: [],
        noAnswerFound: false,
        error: null,
        answerReceived: false
      });

      chrome.runtime.sendMessage({
        type: 'QUESTIONS_DETECTED',
        data: {
          questions: [{ text: normalizedQuestion, hash: questionHash, timestamp: Date.now() }],
          allQuestions: detectedQuestions.map(q => ({
            text: q.text,
            hash: q.hash,
            timestamp: q.timestamp,
            answer: q.answer,
            sources: q.sources || [],
            noAnswerFound: !!q.noAnswerFound,
            error: q.error || null,
            answerReceived: !!q.answerReceived
          }))
        }
      }).catch(() => {});
    }

    queryRAGAPI(normalizedQuestion).catch(err => {
      console.error('❌ QUERY_RAG_QUESTION failed:', err.message);
    });

    return false;
  }

  // Handle API key configuration
  if (message.type === 'SET_OPENAI_KEY') {
    openaiApiKey = message.apiKey;
    chrome.storage.local.set({ openaiApiKey: message.apiKey }, () => {
      console.log('🔑 OpenAI API key saved to storage');
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SET_DEEPGRAM_KEY') {
    deepgramApiKey = message.apiKey;
    chrome.storage.local.set({ deepgramApiKey: message.apiKey }, () => {
      console.log('🔑 Deepgram API key saved to storage');
    });
    sendResponse({ success: true });
    return true;
  }

  // Unknown message type
  return false;
});

// Separate async function for init recording
async function handleInitRecording(tabId) {
  console.log('🎬 Starting recording initialization...');

  // Reset storage for new recording
  audioChunks = [];
  fullTranscript = [];
  sentimentData = [];
  detectedTopics = [];
  detectedIntents = [];
  detectedQuestions = [];
  pendingQuestionPrefix = '';
  processedQuestions = new Set();
  ragAnswers = {};
  isRecording = true;
  recordingStartTime = Date.now();
  recordingTabId = tabId;
  console.log('📝 Recording state initialized');

  // Initialize Deepgram connection if API key is available
  if (deepgramApiKey && deepgramApiKey.length > 0) {
    console.log('✅ API key available, length:', deepgramApiKey.length);
    console.log('🔑 API key preview:', deepgramApiKey.substring(0, 5) + '...');
    
    // Validate API key format (should be reasonably long)
    if (deepgramApiKey.length < 30) {
      console.error('❌ WARNING: API key seems too short (length ' + deepgramApiKey.length + ', expected 30+)');
      console.error('   This might indicate an invalid API key. Try creating a new one from Deepgram console.');
    }
    
    // Check for common invalid formats
    if (deepgramApiKey.includes(' ')) {
      console.error('❌ ERROR: API key contains spaces! This is invalid. Please check your key.');
    }
    if (deepgramApiKey.includes('\n') || deepgramApiKey.includes('\t')) {
      console.error('❌ ERROR: API key contains whitespace characters! Please check your key.');
    }
    
    initDeepgramConnection();
  } else {
    console.error('❌ API key missing or empty!');
    console.warn('⚠️ No Deepgram API key - transcription disabled');
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPTION_ERROR',
      error: 'Deepgram API key not configured in background.js'
    }).catch(() => {});
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
    // Using 'opus' encoding to match our MediaRecorder format
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
            
            // Extract additional insights
            const sentiment = alternative.sentiment;
            const topics = data.metadata?.topics || [];
            const intents = data.metadata?.intents || [];
            
            if (is_final && transcript && transcript.trim() !== '') {
              // Use LLM for sentiment if available, else fall back to rule-based
              const textSentiment = analyzeTextSentimentWithRules(transcript);
              const effectiveSentiment = sentiment || textSentiment;

              // Store final transcript for insights
              fullTranscript.push({
                text: transcript,
                timestamp: Date.now(),
                sentiment: effectiveSentiment,
                speaker: data.channel.alternatives[0].words?.[0]?.speaker
              });

              if (effectiveSentiment) sentimentData.push(effectiveSentiment);
              if (topics.length > 0) detectedTopics.push(...topics);
              if (intents.length > 0) detectedIntents.push(...intents);
              
              console.log('📊 Stored transcript segment:', { sentiment, topics, intents });
              
              // Generate and send live insights with latency (async, using LLM if available)
              generateLiveInsightsWithLLM().then(liveInsights => {
                if (liveInsights) {
                  const now = Date.now();
                  liveInsights.generatedAt = now;
                  // Use the timestamp of the last transcript segment for latency
                  const lastTranscript = fullTranscript[fullTranscript.length - 1];
                  if (lastTranscript && lastTranscript.timestamp) {
                    liveInsights.latencyMs = now - lastTranscript.timestamp;
                  } else {
                    liveInsights.latencyMs = null;
                  }
                  chrome.runtime.sendMessage({
                    type: 'LIVE_INSIGHTS_UPDATE',
                    data: liveInsights
                  }).catch(() => {});
                }

                // Also detect and query new questions from the transcript
                detectAndQueryNewQuestions(transcript);
              }).catch(err => {
                console.error('❌ Error generating live insights:', err);
              });
            }

            // Detect questions from interim/final transcript text so questions appear ASAP in UI
            if (transcript && transcript.trim() !== '') {
              detectAndQueryNewQuestions(transcript);
            }
            
            if (transcript && transcript.trim() !== '') {
              // Send to popup
              chrome.runtime.sendMessage({
                type: 'TRANSCRIPTION_UPDATE',
                data: {
                  transcript: transcript,
                  is_final: is_final,
                  timestamp: Date.now(),
                  sentiment: sentiment
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
        error: 'WebSocket connection error - check API key and network'
      }).catch(() => {});
    };
    
    deepgramSocket.onclose = (event) => {
      console.log('🔌 Deepgram WebSocket closed');
      console.log('Close code:', event.code, 'Reason:', event.reason);
      deepgramConnected = false;
      
      if (event.code !== 1000 && event.code !== 1005) {
        chrome.runtime.sendMessage({
          type: 'TRANSCRIPTION_ERROR',
          error: `Connection closed: ${event.reason || 'Code ' + event.code}`
        }).catch(() => {});
      }
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
  
  // Convert Array back to Uint8Array, then to Blob
  const uint8Array = new Uint8Array(data);
  const audioBlob = new Blob([uint8Array], { type: mimeType });
  
  if (audioBlob.size === 0) {
    console.warn('⚠️ Received empty audio blob from offscreen');
    return;
  }
  
  // Store the audio chunk
  if (isRecording) {
    audioChunks.push(audioBlob);
    const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
    console.log('💾 Audio chunk stored - Total:', audioChunks.length, 'chunks,', audioChunks.reduce((sum, chunk) => sum + chunk.size, 0), 'bytes');
    
    // Send to Deepgram if connected
    if (deepgramConnected && deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
      try {
        audioBlob.arrayBuffer().then(buffer => {
          deepgramSocket.send(buffer);
        }).catch(err => {
          console.error('❌ Error converting audio to buffer:', err.message);
        });
      } catch (err) {
        console.error('❌ Error sending to Deepgram:', err.message);
      }
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
  } else {
    console.warn('⚠️ Received audio chunk but recording is not active - chunk not stored');
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
  
  // Generate insights from collected data
  const insights = generateInsights();
  const insightsGeneratedAt = Date.now();
  // Find the timestamp of the last transcript segment
  let lastTranscriptTimestamp = null;
  if (fullTranscript.length > 0) {
    lastTranscriptTimestamp = fullTranscript[fullTranscript.length - 1].timestamp;
  }
  if (insights) {
    insights.generatedAt = insightsGeneratedAt;
    if (lastTranscriptTimestamp) {
      insights.latencyMs = insightsGeneratedAt - lastTranscriptTimestamp;
    } else {
      insights.latencyMs = null;
    }
  }

  console.log('💡 Generated insights:', insights);

  // Send response as a separate message instead of using sendResponse
  chrome.runtime.sendMessage({
    type: 'STOP_RECORDING_RESPONSE',
    data: responseData
  }).catch(err => {
    console.error('Failed to send stop response:', err);
  });

  // Send insights to popup
  chrome.runtime.sendMessage({
    type: 'INSIGHTS_READY',
    data: insights
  }).catch(err => {
    console.error('Failed to send insights:', err);
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

// Helper: Extract complete questions from transcript
function extractCompleteQuestions(fullTranscript) {
  const questions = [];
  const fullText = fullTranscript.map(t => t.text).join(' ');
  
  // Split by sentence boundaries, then find questions
  const sentences = fullText.match(/[^.?!]+[.?!]+/g) || [];
  
  sentences.forEach(sentence => {
    sentence = sentence.trim();
    // Check if sentence is a question (ends with ?)
    if (sentence.endsWith('?')) {
      // Ensure minimum length and meaningful content (not just single word)
      const words = sentence.replace(/\?$/, '').split(/\s+/).filter(w => w.length > 0);
      if (words.length >= 3) {  // At least 3 words for a proper question
        questions.push(sentence);
      }
    }
  });
  
  return [...new Set(questions)];  // Remove duplicates
}

// Helper: Extract full sentiment lines with surrounding context
function extractFullSentimentLines(fullTranscript, type) {
  const lines = [];
  const sentimentWords = {
    positive: ['great', 'love', 'excellent', 'good', 'happy', 'yes', 'perfect', 'interested',
               'sounds good', 'excited', 'amazing', 'definitely', 'absolutely', 'wonderful', 'fantastic',
               'helpful', 'benefit', 'value', 'impressive', 'exactly', 'makes sense', 'like that', 'like this'],
    negative: ['not', 'never', 'cant', 'cannot', 'wont', 'wouldnt', 'dont', 'difficult',
               'problem', 'issue', 'concern', 'worried', 'expensive', 'too much', 'bad', 'wrong',
               'unfortunately', 'doubt', 'unsure', 'confused', 'challenging', 'struggle', 'disappoint',
               'hesitant', 'objection', 'not sure', 'no idea']
  };
  
  const words = sentimentWords[type] || [];
  
  fullTranscript.forEach((t, idx) => {
    const text = t.text.toLowerCase();
    const hasKeyword = words.some(word => text.includes(word.toLowerCase()));
    
    if (hasKeyword) {
      // Get surrounding context if available
      let context = t.text;
      
      // Add context from adjacent transcript items if they exist
      if (idx > 0 && fullTranscript[idx - 1].text.length < 100) {
        context = fullTranscript[idx - 1].text + ' ' + context;
      }
      if (idx < fullTranscript.length - 1 && fullTranscript[idx + 1].text.length < 100) {
        context = context + ' ' + fullTranscript[idx + 1].text;
      }
      
      context = context.trim();
      if (context.length > 15 && !lines.includes(context)) {  // Avoid very short lines
        lines.push(context);
      }
    }
  });
  
  return lines;
}

// Helper: Extract doubt/concern statements with full context
function extractDoubtsAndConcerns(fullTranscript) {
  const concerns = [];
  const doubtPatterns = [
    // Explicit concerns
    { pattern: /concern|worried|worry|hesita|not sure|unsure|unclear|confusing|confused/i, strength: 'high' },
    { pattern: /what if|what about|what happens/i, strength: 'high' },
    
    // Functionality questions
    { pattern: /does .* (mean|work|matter)|is there|can .* be|could .* be|why .* not/i, strength: 'medium' },
    
    // Objections
    { pattern: /risk|problem|issue|challenge|difficult|complicated|complex/i, strength: 'high' },
    { pattern: /expensive|cost|price|afford|budget|worth|investment|roi/i, strength: 'high' },
    { pattern: /compatible|integration|integrate|support|supported|conflict/i, strength: 'medium' },
    { pattern: /security|safe|data|privacy|compliance|confidential|encrypt|protect/i, strength: 'high' },
    
    // Performance/timeline concerns  
    { pattern: /slow|speed|performance|downtime|impact|break|timeline|ready|prepared/i, strength: 'medium' }
  ];
  
  fullTranscript.forEach((t, idx) => {
    const text = t.text;
    const lowerText = text.toLowerCase();
    
    // Find which pattern(s) match
    doubtPatterns.forEach(({ pattern, strength }) => {
      if (pattern.test(text)) {
        // Extract surrounding context for better understanding
        let contextText = text;
        
        // Add preceding sentence for context
        if (idx > 0 && fullTranscript[idx - 1].text.length < 150) {
          const prevText = fullTranscript[idx - 1].text.trim();
          if (!prevText.endsWith('.') && !prevText.endsWith('?')) {
            contextText = prevText + ' ' + contextText;
          } else {
            contextText = prevText + ' ' + contextText;
          }
        }
        
        // Add following sentence for context
        if (idx < fullTranscript.length - 1 && fullTranscript[idx + 1].text.length < 150) {
          const nextText = fullTranscript[idx + 1].text.trim();
          contextText = contextText + ' ' + nextText;
        }
        
        contextText = contextText.trim();
        
        // Avoid duplicates
        const isDuplicate = concerns.some(c => c.text.toLowerCase() === contextText.toLowerCase());
        if (!isDuplicate && contextText.length > 20) {
          concerns.push({
            text: contextText,
            strength: strength
          });
        }
      }
    });
  });
  
  // Deduplicate and sort by strength
  const unique = [];
  const seen = new Set();
  concerns.forEach(c => {
    const normalized = c.text.toLowerCase().substring(0, 50);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(c);
    }
  });
  
  // Sort high strength first, return top 8
  return unique.sort((a, b) => {
    const strengthMap = { high: 2, medium: 1, low: 0 };
    return (strengthMap[b.strength] || 0) - (strengthMap[a.strength] || 0);
  }).slice(0, 8).map(c => c.text);
}

// Generate live insights (called on each final transcript)
function generateLiveInsights() {
  if (fullTranscript.length === 0) {
    return null;
  }
  
  // Combine all transcript text
  const fullText = fullTranscript.map(t => t.text).join(' ');
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
  
  // Extract actual question and doubt texts using improved context-aware helpers
  const uniqueQuestions = extractCompleteQuestions(fullTranscript).slice(0, 8);
  const uniqueDoubts = extractDoubtsAndConcerns(fullTranscript).slice(0, 8);
  const questions = uniqueQuestions.length;

  // Sentiment analysis - track both counts and contributing FULL lines
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const sentimentLines = { 
    positive: extractFullSentimentLines(fullTranscript, 'positive'),
    neutral: [],
    negative: extractFullSentimentLines(fullTranscript, 'negative')
  };
  
  // Count sentiment from transcript items
  fullTranscript.forEach(t => {
    const sentiment = t.sentiment || 'neutral';
    if (sentiment && sentimentCounts.hasOwnProperty(sentiment)) {
      sentimentCounts[sentiment]++;
    }
  });
  
  const dominantSentiment = Object.entries(sentimentCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
  
  // ADVANCED SALES INSIGHTS
  
  // 1. Buying Signals Detection
  const buyingSignals = [];
  const buyingPhrases = [
    { phrase: /when (can|could|would) (we|i)/i, signal: 'Timeline inquiry - High intent' },
    { phrase: /how (much|expensive|pricing)/i, signal: 'Price discussion - Ready to evaluate' },
    { phrase: /(next steps?|move forward|proceed)/i, signal: 'Advancement intent - Very high intent' },
    { phrase: /(sounds? good|looks? good|interested)/i, signal: 'Positive feedback - Medium intent' },
    { phrase: /(demo|trial|test|try)/i, signal: 'Wants hands-on - High intent' },
    { phrase: /(budget|approve|decision|sign)/i, signal: 'Decision-making mode - Very high intent' },
    { phrase: /(team|stakeholder|boss|manager)/i, signal: 'Involving others - Medium-high intent' }
  ];
  
  fullTranscript.forEach(t => {
    buyingPhrases.forEach(({ phrase, signal }) => {
      if (phrase.test(t.text)) {
        buyingSignals.push({ text: t.text, signal });
      }
    });
  });
  
  // 2. Objections Detection
  const objections = [];
  const objectionPhrases = [
    { phrase: /(too expensive|cost too much|can't afford)/i, type: 'Price objection' },
    { phrase: /(not (sure|ready)|need (time|to think))/i, type: 'Timing objection' },
    { phrase: /(already (have|using)|current (solution|vendor))/i, type: 'Competition objection' },
    { phrase: /(don't (need|see|think)|not (important|priority))/i, type: 'Need objection' },
    { phrase: /(concern|worried|risk|problem with)/i, type: 'General concern' }
  ];
  
  fullTranscript.forEach(t => {
    objectionPhrases.forEach(({ phrase, type }) => {
      if (phrase.test(t.text)) {
        objections.push({ text: t.text, type });
      }
    });
  });
  
  // 3. Intent Classification
  let intentScore = 'Just researching';
  const intentIndicators = {
    veryHigh: /(budget|timeline|contract|sign|purchase|buy now)/i,
    high: /(demo|trial|meeting|call|next week)/i,
    medium: /(interested|tell me more|curious|learn)/i,
    low: /(just looking|maybe later|not sure)/i
  };
  
  if (intentIndicators.veryHigh.test(fullText)) {
    intentScore = 'Ready to buy - Very high intent';
  } else if (intentIndicators.high.test(fullText)) {
    intentScore = 'Actively evaluating - High intent';
  } else if (intentIndicators.medium.test(fullText)) {
    intentScore = 'Interested - Medium intent';
  } else if (intentIndicators.low.test(fullText)) {
    intentScore = 'Just researching - Low intent';
  }
  
  // 4. Emotional State Analysis
  const emotions = [];
  const emotionPatterns = [
    { pattern: /(excited|love|amazing|perfect|exactly)/i, emotion: 'Enthusiastic' },
    { pattern: /(concerned|worried|hesitant|unsure)/i, emotion: 'Cautious' },
    { pattern: /(confused|don't understand|not clear)/i, emotion: 'Confused' },
    { pattern: /(frustrated|annoyed|difficult)/i, emotion: 'Frustrated' },
    { pattern: /(impressed|interesting|like that)/i, emotion: 'Engaged' }
  ];
  
  emotionPatterns.forEach(({ pattern, emotion }) => {
    if (pattern.test(fullText)) {
      emotions.push(emotion);
    }
  });
  
  // 5. Engagement Level
  let engagementLevel = 'Low';
  if (questions > 5) engagementLevel = 'Very High';
  else if (questions > 3) engagementLevel = 'High';
  else if (questions > 1) engagementLevel = 'Medium';
  
  // 6. Pain Points Mentioned
  const painPoints = [];
  const painKeywords = [
    'problem', 'issue', 'challenge', 'difficult', 'struggling',
    'pain', 'frustrating', 'waste', 'slow', 'manual'
  ];
  
  fullTranscript.forEach(t => {
    const lowerText = t.text.toLowerCase();
    painKeywords.forEach(keyword => {
      if (lowerText.includes(keyword)) {
        painPoints.push(t.text);
      }
    });
  });
  
  // Extract key phrases (2-3 word phrases that appear multiple times)
  const phraseRegex = /\b[a-z]{4,}(?:\s+[a-z]{4,}){1,2}\b/gi;
  const phraseCounts = {};
  
  fullTranscript.forEach(t => {
    const matches = t.text.match(phraseRegex) || [];
    matches.forEach(phrase => {
      const normalized = phrase.toLowerCase().trim();
      if (normalized.length > 5) {
        phraseCounts[normalized] = (phraseCounts[normalized] || 0) + 1;
      }
    });
  });
  
  // Filter common words/phrases that aren't meaningful
  const stopPhrases = ['and the', 'in the', 'of the', 'for the', 'to the', 'that is', 'i think'];
  const keyPhrases = Object.entries(phraseCounts)
    .filter(([phrase, count]) => count > 1 && !stopPhrases.includes(phrase))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);
  
  // Detect action items
  const actionVerbs = ['need', 'should', 'must', 'will', 'going to', 'have to', 'plan', 'schedule'];
  const actionItems = fullTranscript
    .filter(t => actionVerbs.some(verb => t.text.toLowerCase().includes(verb)))
    .map(t => t.text)
    .slice(-5);
  
  // Speaker statistics
  const speakers = {};
  fullTranscript.forEach(t => {
    if (t.speaker !== undefined) {
      speakers[t.speaker] = (speakers[t.speaker] || 0) + 1;
    }
  });
  
  const duration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
  
  return {
    isLive: true,
    stats: {
      duration,
      wordCount,
      questions,
      segments: fullTranscript.length,
      speakers: Object.keys(speakers).length
    },
    sentiment: {
      dominant: dominantSentiment,
      breakdown: sentimentCounts,
      lines: sentimentLines
    },
    // SALES-SPECIFIC INSIGHTS
    salesInsights: {
      intentScore,
      engagementLevel,
      buyingSignals: buyingSignals.slice(0, 5),
      objections: objections.slice(0, 5),
      emotions: [...new Set(emotions)],
      painPoints: [...new Set(painPoints)].slice(0, 3)
    },
    keyPhrases,
    actionItems: actionItems.length > 0 ? actionItems : [],
    topics: [...new Set(detectedTopics)].slice(0, 5),
    customerQuestions: uniqueQuestions,
    customerDoubts: uniqueDoubts
  };
}

// Generate insights from collected transcript data
function generateInsights() {
  console.log('🧠 Generating insights from', fullTranscript.length, 'transcript segments');
  
  if (fullTranscript.length === 0) {
    return {
      summary: 'No transcript data available',
      stats: {},
      sentiment: {},
      topics: [],
      actionItems: []
    };
  }
  
  // Combine all transcript text
  const fullText = fullTranscript.map(t => t.text).join(' ');
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;

  const questionList = [];
  const doubtList = [];
  const doubtPatterns = [
    // Explicit concerns and worries
    /concern/i, /worried/i, /worry/i, /concern(ed)?/i, /hesita/i,
    /not sure/i, /unsure/i, /unclear/i, /confusing/i, /confused/i,
    /what if/i, /what about/i, /what happens/i,
    
    // Questions about functionality and compatibility
    /does .* (mean|work|matter)/i, /is there/i, /can .* be/i,
    /could .* be/i, /if .* then/i, /why .* not/i, /how .* work/i,
    /how long/i, /how much/i, /how many/i, /when will/i, /when can/i,
    
    // Potential objections and risks
    /risk/i, /problem/i, /issue/i, /challenge/i, /difficult/i,
    /complicated/i, /complex/i, /concern(ing)?/i, /worried about/i,
    /concerned about/i, /hesitant/i, /unsure about/i, /not convinced/i,
    
    // Compatibility and integration concerns
    /compatible/i, /integration/i, /integrate with/i, /work with/i,
    /support/i, /supported/i, /will it (work|fit|integrate)/i,
    
    // Performance and implementation concerns
    /will it slow|speed|performance|slow down/i, /downtime/i, /impact/i,
    /affect our/i, /break/i, /break anything/i, /conflict/i,
    
    // Cost and ROI concerns
    /expensive/i, /cost/i, /price/i, /afford/i, /budget/i, /worth it/i,
    /investment/i, /return/i, /roi/i, /value/i,
    
    // Timeline and implementation concerns
    /how long will it take/i, /timeline/i, /deadline/i, /rush/i,
    /too fast|quick/i, /enough time/i, /ready/i, /prepared/i,
    
    // Alternative solutions and competitors
    /alternative/i, /other options?/i, /competitors?/i, /versus/i,
    /compared to/i, /similar to/i, /instead of/i, /better than/i,
    
    // Training and adoption concerns
    /learn/i, /training/i, /complicated to use/i, /user friendly/i,
    /easy to use/i, /adoption/i, /understand/i, /learning curve/i,
    
    // Data and security concerns
    /secure/i, /security/i, /safe/i, /data/i, /privacy/i, /compliance/i,
    /confidential/i, /encrypt/i, /protect/i, /backup/i, /loss/i
  ];

  fullTranscript.forEach(t => {
    const text = t.text.trim();
    const questionsInText = [...text.matchAll(/[^.?!]*\?/g)]
      .map(match => match[0].trim())
      .filter(Boolean);

    questionsInText.forEach(question => {
      questionList.push(question);
      if (doubtPatterns.some(pattern => pattern.test(question)) && !doubtList.includes(question)) {
        doubtList.push(question);
      }
    });

    if (doubtPatterns.some(pattern => pattern.test(text)) && !doubtList.includes(text)) {
      doubtList.push(text);
    }
  });

  const questions = questionList.length;
  
  // Sentiment analysis - track both counts and contributing lines
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  const sentimentLines = { positive: [], neutral: [], negative: [] };
  
  fullTranscript.forEach(t => {
    const sentiment = t.sentiment || 'neutral';
    if (sentiment && sentimentCounts.hasOwnProperty(sentiment)) {
      sentimentCounts[sentiment]++;
      if (t.text && t.text.trim()) {
        sentimentLines[sentiment].push(t.text);
      }
    }
  });
  
  const dominantSentiment = Object.entries(sentimentCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
  
  // Extract key phrases (2-3 word phrases that appear multiple times)
  const phraseRegex = /\b[a-z]{4,}(?:\s+[a-z]{4,}){1,2}\b/gi;
  const phraseCounts = {};
  
  fullTranscript.forEach(t => {
    const matches = t.text.match(phraseRegex) || [];
    matches.forEach(phrase => {
      const normalized = phrase.toLowerCase().trim();
      if (normalized.length > 5) {
        phraseCounts[normalized] = (phraseCounts[normalized] || 0) + 1;
      }
    });
  });
  
  // Filter common words/phrases that aren't meaningful
  const stopPhrases = ['and the', 'in the', 'of the', 'for the', 'to the', 'that is', 'i think'];
  const keyPhrases = Object.entries(phraseCounts)
    .filter(([phrase, count]) => count > 1 && !stopPhrases.includes(phrase))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);
  
  // Detect action items (statements with action verbs)
  const actionVerbs = ['need', 'should', 'must', 'will', 'going to', 'have to', 'plan', 'schedule', 'follow up', 'book', 'send', 'review'];
  const actionItems = fullTranscript
    .filter(t => actionVerbs.some(verb => t.text.toLowerCase().includes(verb)))
    .map(t => t.text.trim())
    .slice(0, 5);

  if (actionItems.length === 0 && questionList.length > 0) {
    actionItems.push(`Follow up on customer question: "${questionList[0]}"`);
  }
  
  // Speaker statistics (if diarization is available)
  const speakers = {};
  fullTranscript.forEach(t => {
    if (t.speaker !== undefined) {
      speakers[t.speaker] = (speakers[t.speaker] || 0) + 1;
    }
  });
  
  // Generate summary
  const duration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : 0;
  const summary = `${duration}s conversation with ${wordCount} words. ` +
    `Overall sentiment: ${dominantSentiment}. ` +
    `${questions} questions asked. ` +
    `${actionItems.length} action items identified.`;
  
  const uniqueQuestions = [...new Set(questionList)].slice(0, 8);
  const uniqueDoubts = [...new Set(doubtList)].slice(0, 8);

  return {
    summary,
    fullText, // Include for AI analysis
    stats: {
      duration,
      wordCount,
      questions: uniqueQuestions.length,
      doubts: uniqueDoubts.length,
      segments: fullTranscript.length,
      speakers: Object.keys(speakers).length
    },
    sentiment: {
      dominant: dominantSentiment,
      breakdown: sentimentCounts,
      lines: sentimentLines
    },
    topics: [...new Set(detectedTopics)].slice(0, 5),
    keyPhrases,
    actionItems,
    customerQuestions: uniqueQuestions,
    customerDoubts: uniqueDoubts,
    speakerStats: speakers
  };
}

// Generate AI-powered summary using OpenAI or similar
async function handleGenerateAISummary(transcript) {
  console.log('🤖 Generating AI summary for transcript length:', transcript.length);
  
  // Check if OpenRouter API key is available
  const configuredApiKey = openaiApiKey;
  
  if (!configuredApiKey) {
    // Fallback: Generate a rule-based summary
    const fallbackSummary = generateFallbackSummary(transcript);
    chrome.runtime.sendMessage({
      type: 'AI_SUMMARY_READY',
      data: fallbackSummary
    }).catch(() => {});
    return;
  }
  
  try {
    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${configuredApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'system',
          content: `You are an expert sales coach. A sales rep just finished a call and needs your immediate, specific guidance. Analyze the transcript and respond using these exact markdown sections:

## BUYER INTENT SCORE
State a score from 0–100% and one of: Not Interested / Just Exploring / Showing Interest / Probable Buyer / Ready to Buy. Then one sentence explaining the rating based on what was actually said.

## WHAT HAPPENED
2–3 bullet points summarizing the key moments of this call. Quote the prospect directly where relevant.

## PROSPECT SIGNALS
- **Positive signals:** list buying signals, interest indicators, or encouraging statements
- **Objections / concerns:** list hesitations, doubts, or pushback — be specific
- **Emotional state:** describe how the prospect came across (enthusiastic, skeptical, confused, warm, etc.)

## WHAT TO DO NEXT
Number these action items in priority order. Be direct and specific — tell the rep exactly what to say or do, not generic advice.

## DEAL HEALTH
**Overall:** Strong / Medium / Weak / Dead
**Biggest risk:** one sentence
**Best opportunity:** one sentence

Keep total response under 450 words. Be direct. Reference actual words from the transcript.`
        }, {
          role: 'user',
          content: `Here is the sales call transcript to analyze:\n\n${transcript}`
        }],
        max_tokens: 1000,
        temperature: 0.4
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      let errorMessage = `OpenAI API error: ${response.status}`;
      
      if (response.status === 429) {
        errorMessage = 'Rate limit exceeded or insufficient credits. Please check your OpenAI account billing or wait a moment and try again.';
      } else if (response.status === 401) {
        errorMessage = 'Invalid OpenAI API key. Please check your API key in settings.';
      } else if (response.status === 400) {
        errorMessage = 'Invalid request format. The transcript may be too long.';
      }
      
      throw new Error(errorMessage);
    }
    
    const data = await response.json();
    const summary = data.choices[0].message.content;
    
    console.log('✅ AI summary generated:', summary);
    
    chrome.runtime.sendMessage({
      type: 'AI_SUMMARY_READY',
      data: summary
    }).catch(() => {});
    
  } catch (err) {
    console.error('❌ Error generating AI summary:', err);
    
    // Send error message to user
    chrome.runtime.sendMessage({
      type: 'AI_SUMMARY_ERROR',
      error: err.message
    }).catch(() => {});
    
    // Don't fallback for API errors - let user know what went wrong
    return;
  }
}

// Fallback summary when AI is not available
function generateFallbackSummary(transcript) {
  const sentences = transcript.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const wordCount = transcript.split(/\s+/).length;
  
  // Extract questions
  const questions = sentences.filter(s => s.includes('?'));
  
  // Extract sentences with key sales terms
  const keyTerms = ['price', 'cost', 'budget', 'need', 'want', 'problem', 'solution', 'benefit', 'feature'];
  const keySentences = sentences.filter(s => 
    keyTerms.some(term => s.toLowerCase().includes(term))
  ).slice(0, 3);
  
  let summary = `Quick Analysis (${wordCount} words):\n\n`;
  
  if (questions.length > 0) {
    summary += `Key Questions (${questions.length}):\n`;
    questions.slice(0, 3).forEach(q => {
      summary += `- ${q.trim()}?\n`;
    });
    summary += '\n';
  }
  
  if (keySentences.length > 0) {
    summary += `Important Points:\n`;
    keySentences.forEach(s => {
      summary += `- ${s.trim()}.\n`;
    });
    summary += '\n';
  }
  
  summary += `Tip: Add an OpenAI API key in extension settings for deeper AI-powered insights!`;
  
  return summary;
}

// ── LLM API Functions for Real-time Insights ──────────────────

async function generateLiveInsightsWithLLM() {
  if (fullTranscript.length === 0) {
    return null;
  }
  
  const now = Date.now();
  
  // Only generate insights every 10 seconds (batch processing for cost efficiency)
  if (now - lastInsightGenerationTime < INSIGHT_GENERATION_INTERVAL) {
    return null;
  }
  
  lastInsightGenerationTime = now;
  
  // Get transcript since last generation
  const recentTranscript = fullTranscript
    .map(t => t.text)
    .join(' ')
    .substring(0, 1500); // Limit to last 1500 chars to reduce API cost
  
  if (recentTranscript.trim().length < 50) {
    return null;
  }
  
  console.log('🤖 Calling OpenAI for live insights...');
  
  try {
    const insights = await callOpenAIForLiveInsights(recentTranscript);
    return {
      ...insights,
      generatedAt: now,
      source: 'llm'
    };
  } catch (err) {
    console.error('❌ LLM insight generation failed:', err);
    // Fallback to rule-based
    console.log('⚠️ Falling back to rule-based insights');
    return generateLiveInsights();
  }
}

async function callOpenAIForLiveInsights(transcript) {
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }
  
  const systemPrompt = `You are a real-time sales intelligence analyst for high-stakes sales conversations. Your job is NOT to summarize or repeat the transcript. Instead:

ANALYZE CUSTOMER INTENT:
- What underlying problem is the customer trying to solve? (not just what they say, but what drives it)
- What questions reveal their true priorities and concerns?
- What is the customer's emotional temperature? (confident, skeptical, anxious, indifferent?)
- Are they comparing alternatives? What does that tell you about their evaluation criteria?

EXTRACT STRATEGIC INSIGHTS:
- Identify hidden objections (things they don't say directly but imply)
- Spot decision criteria from their questions (timeline? budget? integration? security?)
- Recognize buying momentum signals vs. stalling tactics
- Note what they DON'T ask about (gaps in their thinking?)

PROVIDE ACTIONABLE INTELLIGENCE:
- What should the rep emphasize RIGHT NOW to move the deal forward?
- Where is the customer most vulnerable to losing to competitors?
- What single question would reveal if this is a real opportunity?

RESPOND WITH THIS JSON STRUCTURE - ONLY VALID JSON, NO MARKDOWN OR BACKTICKS:
{
  "customerNeeds": ["actual underlying need #1", "actual need #2 - inferred from questions"],
  "buyingSignals": ["specific positive indicator with context", "another signal showing intent"],
  "hiddenObjections": ["unstated concern implied by their questions", "potential blocker not mentioned directly"],
  "decisionCriteria": ["what matters to them based on what they ask about", "e.g. 'timeline critical - asked 3x about implementation speed'"],
  "sentiment": "positive|neutral|skeptical|anxious",
  "competitorRisk": "low|medium|high - are they comparing to alternatives?",
  "immediateAction": "one specific sentence on what to do/say in the next 30 seconds to advance the deal",
  "riskLevel": "low|medium|high - likelihood of losing this deal if you don't act now"
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this sales conversation segment:\n\n${transcript}` }
        ],
        max_tokens: 300,
        temperature: 0.3
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI API error: ${response.status} - ${error.error?.message || 'Unknown error'}`);
    }
    
    const data = await response.json();
    const content = data.choices[0].message.content;
    
    console.log('🤖 LLM Response:', content);
    
    // Parse JSON response
    let insights;
    try {
      insights = JSON.parse(content);
    } catch (e) {
      console.error('❌ Failed to parse LLM response:', content);
      throw new Error('Invalid JSON from LLM');
    }
    console.log({insights})
    
    // Return ALL refined insight fields - not just a subset
    return {
      customerNeeds: insights.customerNeeds || [],
      buyingSignals: insights.buyingSignals || [],
      hiddenObjections: insights.hiddenObjections || [],
      decisionCriteria: insights.decisionCriteria || [],
      sentiment: insights.sentiment || 'neutral',
      competitorRisk: insights.competitorRisk || 'low',
      immediateAction: insights.immediateAction || '',
      riskLevel: insights.riskLevel || 'medium'
    };
  } catch (err) {
    console.error('❌ OpenAI API call failed:', err);
    throw err;
  }
}

async function analyzeTextSentimentWithLLM(text) {
  if (!openaiApiKey || !text || text.trim().length === 0) {
    return analyzeTextSentimentWithRules(text); // Fallback
  }
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Respond with ONLY one word: "positive", "neutral", or "negative"' },
          { role: 'user', content: `Sentiment of: "${text}"` }
        ],
        max_tokens: 10,
        temperature: 0
      })
    });
    
    if (!response.ok) {
      return analyzeTextSentimentWithRules(text);
    }
    
    const data = await response.json();
    const sentiment = data.choices[0].message.content.toLowerCase().trim();
    
    if (['positive', 'neutral', 'negative'].includes(sentiment)) {
      console.log(`📊 LLM Sentiment: "${text.substring(0, 50)}..." → ${sentiment}`);
      return sentiment;
    }
    
    return analyzeTextSentimentWithRules(text);
  } catch (err) {
    console.warn('⚠️ Sentiment LLM call failed, using rules:', err.message);
    return analyzeTextSentimentWithRules(text);
  }
}

function analyzeTextSentimentWithRules(text) {
  const lower = text.toLowerCase();
  const positiveWords = ['great', 'love', 'excellent', 'good', 'happy', 'yes', 'perfect', 'interested',
    'sounds good', 'excited', 'amazing', 'definitely', 'absolutely', 'wonderful', 'fantastic',
    'helpful', 'benefit', 'value', 'impressive', 'exactly', 'makes sense', 'like that', 'like this'];
  const negativeWords = ['not', 'never', 'cant', 'cannot', 'wont', 'wouldnt', 'dont', 'difficult',
    'problem', 'issue', 'concern', 'worried', 'expensive', 'too much', 'bad', 'wrong',
    'unfortunately', 'doubt', 'unsure', 'confused', 'challenging', 'struggle', 'disappoint',
    'hesitant', 'objection', 'not sure', 'no idea'];

  let posScore = 0, negScore = 0;
  positiveWords.forEach(w => { if (lower.includes(w)) posScore++; });
  negativeWords.forEach(w => { if (lower.includes(w)) negScore++; });

  if (posScore > negScore) return 'positive';
  if (negScore > posScore) return 'negative';
  return 'neutral';
}

function generateSalesCoachInsights(fullText) {
  if (!fullText || fullText.trim().length === 0) return null;

  const strongBuySignals = [
    /\b(ready to buy|let'?s proceed|sign the contract|move forward|let'?s do it)\b/i,
    /\b(how (do|can) (i|we) (get started|sign up|buy|purchase))\b/i,
    /\b(when can (we|i) start|send (me|us) the (contract|agreement|invoice))\b/i,
    /\b(i('?m| am) (sold|in)|we('?re| are) (in|ready)|yes,? let'?s)\b/i
  ];

  const clearNoSignals = [
    /\b(not interested|not for us|don'?t need this|no thank you|pass on this|not the right fit)\b/i,
    /\b(can'?t afford|way too expensive|no budget|out of (our )?budget)\b/i,
    /\b(already (decided|chosen|selected)|going with (someone else|another|a competitor))\b/i,
    /\b(not a priority|very low priority|no plans for this)\b/i
  ];

  const probableBuyerSignals = [
    /\b(next steps?|follow[- ]?up|schedule (a )?(demo|call|meeting))\b/i,
    /\b(interested in (seeing|learning|trying)|sounds (good|interesting|promising))\b/i,
    /\b(like what (i'?m|i am) hearing|makes sense|can you (show|send|share))\b/i,
    /\b(trial|pilot|proof of concept|poc|sandbox)\b/i
  ];

  const exploringSignals = [
    /\b(just (looking|exploring)|comparing (options|solutions|vendors)|evaluating|researching)\b/i,
    /\b(tell me more|more information|more details|learn more|curious about)\b/i,
    /\b(what if|how would|could you|would it be|is it possible)\b/i
  ];

  const strongBuyCount = strongBuySignals.filter(p => p.test(fullText)).length;
  const clearNoCount   = clearNoSignals.filter(p => p.test(fullText)).length;
  const probableCount  = probableBuyerSignals.filter(p => p.test(fullText)).length;
  const exploringCount = exploringSignals.filter(p => p.test(fullText)).length;

  let intentLevel, intentLabel, intentColor, intentEmoji;

  if (clearNoCount >= 1 && strongBuyCount === 0 && probableCount === 0) {
    intentLevel = 'not-interested'; intentLabel = 'Not Interested';
    intentColor = '#ea4335'; intentEmoji = '🔴';
  } else if (strongBuyCount >= 1) {
    intentLevel = 'ready-to-buy'; intentLabel = 'Ready to Buy';
    intentColor = '#34a853'; intentEmoji = '🟢';
  } else if (probableCount >= 1) {
    intentLevel = 'probable-buyer'; intentLabel = 'Probable Buyer';
    intentColor = '#fbbc04'; intentEmoji = '🟡';
  } else if (exploringCount >= 1) {
    intentLevel = 'exploring'; intentLabel = 'Just Exploring';
    intentColor = '#ff9800'; intentEmoji = '🟠';
  } else {
    intentLevel = 'neutral'; intentLabel = 'Intent Unclear';
    intentColor = '#9e9e9e'; intentEmoji = '⚪';
  }

  const nextActions = {
    'not-interested': 'Address the core objection directly. Ask: "What specifically is your main concern?" Then listen — do not pitch.',
    'ready-to-buy':   'Close NOW. Stop selling. Propose the contract, trial start date, or next concrete step and go quiet.',
    'probable-buyer': 'Strike while warm. Schedule a follow-up demo or proposal within 24–48 hours. Tie value to their specific pain.',
    'exploring':      'Be a consultant, not a pitcher. Share a relevant ROI data point or case study. Ask: "What\'s your evaluation criteria?"',
    'neutral':        'Gauge intent directly: "On a scale of 1–10, how urgent is solving this problem right now?" Then listen carefully.'
  };

  const coachingTips = {
    'not-interested': 'Acknowledge concern first ("I hear you..."). Reframe value around their specific pain, then ask if there\'s a version of this that would work for them.',
    'ready-to-buy':   'Every extra word risks introducing doubt. Present one clear next step — then stop talking.',
    'probable-buyer': 'Momentum is your friend. Make the next step completely friction-free — offer to send a calendar invite right now.',
    'exploring':      'Understand their evaluation process before you try to sell. Find out who else is involved in the decision.',
    'neutral':        'Figure out if this person is the actual decision-maker. Is there a timeline? Is there a budget? Qualify before you invest more time.'
  };

  const riskFactors = [];
  if (/\b(competitor|alternative|other (vendor|option|solution|provider))\b/i.test(fullText))
    riskFactors.push('Evaluating competitors');
  if (/\b(budget|cost|expensive|price|afford)\b/i.test(fullText))
    riskFactors.push('Price sensitivity detected');
  if (/\b(not (sure|ready)|need (time|to think|approval)|think about it)\b/i.test(fullText))
    riskFactors.push('Decision hesitation');
  if (/\b(manager|boss|team|stakeholder|committee|approval|sign[- ]?off)\b/i.test(fullText))
    riskFactors.push('Multiple decision-makers involved');
  if (/\b(later|future|next (quarter|year|month|cycle))\b/i.test(fullText))
    riskFactors.push('Timeline delay risk');
  if (clearNoCount > 0 && probableCount > 0)
    riskFactors.push('Mixed signals — probe to find the real blocker');

  const opportunities = [];
  if (/\b(pain|problem|struggle|challenge|difficult|issue|frustrat)\b/i.test(fullText))
    opportunities.push('Pain point identified — anchor your value prop here');
  if (/\b(deadline|urgent|asap|quickly|soon|immediately)\b/i.test(fullText))
    opportunities.push('Urgency expressed — use timing as leverage');
  if (/\b(budget|approved|allocated|set aside)\b/i.test(fullText) && !/too expensive/i.test(fullText))
    opportunities.push('Budget may be available — confirm allocation');
  if (/\b(referral|recommended|told about|heard from|colleague sent)\b/i.test(fullText))
    opportunities.push('Warm referral — trust factor is already high');
  if (/\b(impressed|interesting|like (that|this|it)|exciting|promising)\b/i.test(fullText))
    opportunities.push('Positive reactions detected — reinforce those key benefits');

  return {
    intentLevel,
    intentLabel,
    intentColor,
    intentEmoji,
    nextAction: nextActions[intentLevel],
    coachingTip: coachingTips[intentLevel],
    riskFactors: riskFactors.slice(0, 4),
    opportunities: opportunities.slice(0, 4)
  };
}

function handleDownloadRecording() {
  console.log('💾 Download requested - Combining', audioChunks.length, 'chunks');

  const sendDownloadResponse = (data) => {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_RESPONSE', data }).catch(err => {
      console.error('Failed to send download response:', err);
    });
  };

  if (audioChunks.length === 0) {
    console.error('❌ CRITICAL: No audio chunks recorded - offscreen document may not have sent audio');
    sendDownloadResponse({ success: false, error: 'No audio chunks recorded. Check browser console for details.' });
    return;
  }

  try {
    const finalBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
    console.log('✅ Combined blob size:', finalBlob.size, 'bytes');
    
    if (finalBlob.size === 0) {
      console.error('❌ Blob is empty - audio chunks have no data');
      sendDownloadResponse({ success: false, error: 'Audio data is empty' });
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.result) {
        console.log('✅ Data URL ready, length:', reader.result.length);
        sendDownloadResponse({ success: true, dataUrl: reader.result, size: finalBlob.size });
      } else {
        console.error('❌ FileReader produced no result');
        sendDownloadResponse({ success: false, error: 'FileReader failed' });
      }
    };
    reader.onerror = (error) => {
      console.error('❌ FileReader error:', reader.error?.message);
      sendDownloadResponse({ success: false, error: `FileReader error: ${reader.error?.message}` });
    };
    reader.readAsDataURL(finalBlob);
  } catch (err) {
    console.error('❌ Exception in handleDownloadRecording:', err.message);
    sendDownloadResponse({ success: false, error: err.message });
  }
}

function handleGetRecordingBlob() {
  console.log('🎧 Playback requested');

  const sendPlaybackResponse = (data) => {
    chrome.runtime.sendMessage({
      type: 'PLAYBACK_RESPONSE',
      data: data
    }).catch(err => {
      console.error('Failed to send playback response:', err);
    });
  };

  if (audioChunks.length === 0) {
    console.error('❌ CRITICAL: No audio chunks available for playback - offscreen document may not have sent audio');
    sendPlaybackResponse({ success: false, error: 'No audio chunks recorded. Check browser console for details.' });
    return;
  }

  try {
    console.log('📦 Creating final blob from', audioChunks.length, 'chunks');
    const finalBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
    console.log('✅ Final blob created, size:', finalBlob.size, 'bytes');
    
    if (finalBlob.size === 0) {
      console.error('❌ Blob is empty - audio chunks have no data');
      sendPlaybackResponse({ success: false, error: 'Audio data is empty' });
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.result) {
        console.log('✅ Data URL created, length:', reader.result.length);
        sendPlaybackResponse({ success: true, dataUrl: reader.result });
      } else {
        console.error('❌ FileReader produced no result');
        sendPlaybackResponse({ success: false, error: 'FileReader failed' });
      }
    };

    reader.onerror = (error) => {
      console.error('❌ FileReader error:', reader.error?.message);
      sendPlaybackResponse({ success: false, error: `FileReader error: ${reader.error?.message}` });
    };

    reader.readAsDataURL(finalBlob);
  } catch (err) {
    console.error('❌ Exception in GET_RECORDING_BLOB:', err.message);
    sendPlaybackResponse({ success: false, error: err.message });
  }
}

// ── RAG API Functions for Document Search ──────────────────

// Create a hash key for a question to track if we've already queried it
function hashQuestion(question) {
  let hash = 0;
  const str = question.toLowerCase().trim();
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return 'q_' + Math.abs(hash).toString(36);
}

function extractQuestionsFromText(text) {
  if (!text || text.trim().length === 0) {
    return;
  }

  const cleaned = text.replace(/\s+/g, ' ').trim();

  // Explicit question mark detection
  const markedQuestions = [...cleaned.matchAll(/[^.?!\n]*\?/g)]
    .map(match => match[0].trim())
    .filter(q => q.length >= 8);
  markedQuestions.forEach(q => addCandidateToPending(q));

  // Heuristic detection for spoken questions without '?'
  const prefixes = /^(who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|am|will|may|might|have|has|had|which)\b/i;
  const intentQuestionPatterns = [
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
  if (pendingQuestionPrefix && chunks.length > 0) {
    chunks[0] = `${pendingQuestionPrefix} ${chunks[0]}`.replace(/\s+/g, ' ').trim();
    pendingQuestionPrefix = '';
  }

  chunks.forEach(chunk => {
    const looksLikeQuestion = prefixes.test(chunk) || intentQuestionPatterns.some(pattern => pattern.test(chunk));
    if (looksLikeQuestion && chunk.length >= 8) {
      if (trailingConnector.test(chunk) && !/[.?!]$/.test(chunk)) {
        // Ends with connector: hold for next chunk
        pendingQuestionPrefix = chunk;
      } else {
        // Looks complete: add to pending queue
        const normalized = chunk.endsWith('?') ? chunk : `${chunk}?`;
        addCandidateToPending(normalized);
      }
    }
  });

  // If this raw text is itself an unfinished starter, hold it for the next chunk.
  if ((prefixes.test(cleaned) || intentQuestionPatterns.some(pattern => pattern.test(cleaned))) && trailingConnector.test(cleaned) && !/[.?!]$/.test(cleaned)) {
    pendingQuestionPrefix = cleaned;
  }
}

function addCandidateToPending(candidateText) {
  if (!candidateText || candidateText.trim().length === 0) return;
  
  const normalized = candidateText.trim();
  const hash = hashCandidate(normalized);
  const confidence = scoreQuestionConfidence(normalized);
  
  const now = Date.now();
  if (pendingCandidates[hash]) {
    // Update existing candidate: extend if it's being re-confirmed
    pendingCandidates[hash].lastUpdatedAt = now;
    pendingCandidates[hash].extendCount = (pendingCandidates[hash].extendCount || 0) + 1;
    pendingCandidates[hash].confidence = Math.max(pendingCandidates[hash].confidence, confidence);
    console.log('📝 Extended pending candidate:', normalized, 'score:', pendingCandidates[hash].confidence);
  } else {
    // New candidate
    pendingCandidates[hash] = {
      text: normalized,
      firstSeenAt: now,
      lastUpdatedAt: now,
      confidence: confidence,
      extendCount: 0
    };
    console.log('🔔 Added pending candidate:', normalized, 'confidence:', confidence);
  }
}

// Query the RAG API for a question
async function queryRAGAPI(question) {
  if (!ragBaseUrl || ragBaseUrl.length === 0) {
    console.log('⚠️ RAG API URL not configured, skipping document search');
    return null;
  }

  if (!question || question.trim().length === 0) {
    return null;
  }

  const questionHash = hashQuestion(question);

  // Check if we've already queried this question (allow retries by removing from cache)
  if (processedQuestions.has(questionHash)) {
    console.log('ℹ️ Question already processed, sending cached answer');
    const cachedAnswer = ragAnswers[questionHash];
    if (cachedAnswer) {
      chrome.runtime.sendMessage({
        type: 'RAG_ANSWER_READY',
        data: {
          question,
          questionHash,
          ragResponse: cachedAnswer
        }
      }).catch(() => {});
      return cachedAnswer;
    }
    return null;
  }

  // Mark this question as processed
  processedQuestions.add(questionHash);

  try {
    console.log('🤖 Querying OpenAI API for question:', question);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RAG_QUERY_TIMEOUT_MS);

    const response = await fetch(`${ragBaseUrl}/rag/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: question,
        top_k: 3,
        use_hyde: false,
        use_rerank: false
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error('❌ RAG API error:', response.status, response.statusText);
      const errorResponse = {
        query: question,
        answer: '',
        sources: [],
        noAnswerFound: true,
        error: `Knowledge base error (${response.status})`
      };

      ragAnswers[questionHash] = errorResponse;

      const questionEntry = detectedQuestions.find(q => q.hash === questionHash);
      if (questionEntry) {
        questionEntry.answer = '';
        questionEntry.sources = [];
        questionEntry.noAnswerFound = true;
        questionEntry.error = errorResponse.error;
        questionEntry.answerReceived = true;
      }

      chrome.runtime.sendMessage({
        type: 'RAG_ANSWER_READY',
        data: {
          question,
          questionHash,
          ragResponse: errorResponse
        }
      }).catch(() => {});

      return errorResponse;
    }

    const data = await response.json();
    
    if (!data.answer || data.answer.trim().length === 0) {
      console.warn('⚠️ RAG API returned empty answer for question:', question);
      const noAnswerResponse = {
        query: data.query || question,
        answer: '',
        sources: normalizeSourceList(data.sources || []),
        noAnswerFound: true,
        error: null
      };

      ragAnswers[questionHash] = noAnswerResponse;

      const questionEntry = detectedQuestions.find(q => q.hash === questionHash);
      if (questionEntry) {
        questionEntry.answer = '';
        questionEntry.sources = noAnswerResponse.sources;
        questionEntry.noAnswerFound = true;
        questionEntry.answerReceived = true;
      }

      chrome.runtime.sendMessage({
        type: 'RAG_ANSWER_READY',
        data: {
          question,
          questionHash,
          ragResponse: noAnswerResponse
        }
      }).catch(() => {});

      return noAnswerResponse;
    }
    console.log('✅ RAG API returned answer');
    
    // Cache the answer
    const ragResponse = {
      query: data.query,
      answer: data.answer,
      sources: normalizeSourceList(data.sources || []),
      retrieval_method: data.retrieval_method || 'unknown',
      reranked: data.reranked || false,
      noAnswerFound: false,
      error: null
    };

    ragAnswers[questionHash] = ragResponse;

    // Update detected questions with the answer
    const questionEntry = detectedQuestions.find(q => q.hash === questionHash);
    if (questionEntry) {
      questionEntry.answer = ragResponse.answer;
      questionEntry.sources = ragResponse.sources;
      questionEntry.answerReceived = true;
    }

    // Send to popup
    chrome.runtime.sendMessage({
      type: 'RAG_ANSWER_READY',
      data: {
        question: question,
        questionHash: questionHash,
        ragResponse: ragResponse
      }
    }).catch(() => {});

    return ragResponse;

  } catch (err) {
    console.error('❌ RAG API query failed:', err.message);

    const failureResponse = {
      query: question,
      answer: '',
      sources: [],
      noAnswerFound: true,
      error: err.name === 'AbortError' ? 'Knowledge base search timed out' : 'Unable to reach knowledge base'
    };

    ragAnswers[questionHash] = failureResponse;

    const questionEntry = detectedQuestions.find(q => q.hash === questionHash);
    if (questionEntry) {
      questionEntry.answer = '';
      questionEntry.sources = [];
      questionEntry.noAnswerFound = true;
      questionEntry.error = failureResponse.error;
      questionEntry.answerReceived = true;
    }

    chrome.runtime.sendMessage({
      type: 'RAG_ANSWER_READY',
      data: {
        question,
        questionHash,
        ragResponse: failureResponse
      }
    }).catch(() => {});

    return failureResponse;
  }
}

// Detect new questions and query RAG API
function detectAndQueryNewQuestions(latestTranscript = '') {
  if (fullTranscript.length === 0 && (!latestTranscript || latestTranscript.trim().length === 0)) {
    return;
  }

  // Extract candidates from full transcript and latest transcript
  // This adds candidates to pendingCandidates, doesn't return them
  fullTranscript.forEach(t => {
    extractQuestionsFromText(t.text);
  });

  if (latestTranscript && latestTranscript.trim().length > 0) {
    extractQuestionsFromText(latestTranscript);
  }

  // confirmPendingCandidates runs on a timer and will promote ready candidates
  // No need to broadcast questions here anymore
}