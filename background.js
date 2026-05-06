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

// Storage for transcripts and insights
let fullTranscript = [];
let sentimentData = [];
let detectedTopics = [];
let detectedIntents = [];

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

  // Handle download request — response sent via DOWNLOAD_RESPONSE message
  if (message.type === 'DOWNLOAD_RECORDING') {
    handleDownloadRecording();
    return false;
  }

  // Handle playback request
  if (message.type === 'GET_RECORDING_BLOB') {
    handleGetRecordingBlob(sendResponse);
    return true; // Keep channel open for async response
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
              // Use Deepgram sentiment if available, else fall back to rule-based
              const textSentiment = analyzeTextSentiment(transcript);
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
              
              // Generate and send live insights with latency
              const liveInsights = generateLiveInsights();
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

// Generate live insights (called on each final transcript)
function generateLiveInsights() {
  if (fullTranscript.length === 0) {
    return null;
  }
  
  // Combine all transcript text
  const fullText = fullTranscript.map(t => t.text).join(' ');
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
  
  // Extract actual question and doubt texts
  const questionList = [];
  const doubtList = [];
  const doubtPatterns = [
    /concern/i, /worried/i, /not sure/i, /unclear/i, /what if/i,
    /does .* (mean|work|matter)/i, /is there/i, /can .* be/i,
    /could .* be/i, /if .* then/i, /why .* not/i, /how .* work/i
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

  const uniqueQuestions = [...new Set(questionList)].slice(0, 8);
  const uniqueDoubts = [...new Set(doubtList)].slice(0, 8);
  const questions = uniqueQuestions.length;

  // Sentiment analysis
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  sentimentData.forEach(s => {
    if (s) sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
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
  
  // Extract key phrases (words that appear multiple times)
  const words = fullText.toLowerCase()
    .replace(/[.,?!]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 4);
  
  const wordFreq = {};
  words.forEach(w => {
    wordFreq[w] = (wordFreq[w] || 0) + 1;
  });
  
  const keyPhrases = Object.entries(wordFreq)
    .filter(([_, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
  
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
      breakdown: sentimentCounts
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
    customerDoubts: uniqueDoubts,
    salesCoach: generateSalesCoachInsights(fullText)
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
    /concern/i,
    /worried/i,
    /not sure/i,
    /unclear/i,
    /what if/i,
    /does .* (mean|work|matter)/i,
    /is there/i,
    /can .* be/i,
    /could .* be/i,
    /if .* then/i,
    /why .* not/i,
    /how .* work/i
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
  
  // Sentiment analysis
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  sentimentData.forEach(s => {
    if (s) sentimentCounts[s] = (sentimentCounts[s] || 0) + 1;
  });
  
  const dominantSentiment = Object.entries(sentimentCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';
  
  // Extract key phrases (words that appear multiple times)
  const words = fullText.toLowerCase()
    .replace(/[.,?!]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 4); // Only words longer than 4 chars
  
  const wordFreq = {};
  words.forEach(w => {
    wordFreq[w] = (wordFreq[w] || 0) + 1;
  });
  
  const keyPhrases = Object.entries(wordFreq)
    .filter(([_, count]) => count > 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
  
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
      breakdown: sentimentCounts
    },
    topics: [...new Set(detectedTopics)].slice(0, 5),
    keyPhrases,
    actionItems,
    customerQuestions: uniqueQuestions,
    customerDoubts: uniqueDoubts,
    speakerStats: speakers,
    salesCoach: generateSalesCoachInsights(fullText)
  };
}

// Generate AI-powered summary using OpenAI or similar
async function handleGenerateAISummary(transcript) {
  console.log('🤖 Generating AI summary for transcript length:', transcript.length);
  
  // Check if OpenAI API key is available
  const result = await chrome.storage.local.get(['openaiApiKey']);
  const openaiApiKey = result.openaiApiKey;
  
  if (!openaiApiKey) {
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
        'Authorization': `Bearer ${openaiApiKey}`
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

function analyzeTextSentiment(text) {
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
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_RESPONSE', data }).catch(() => {});
  };

  if (audioChunks.length === 0) {
    sendDownloadResponse({ success: false, error: 'No audio chunks recorded' });
    return;
  }

  const finalBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
  console.log('✅ Combined blob size:', finalBlob.size, 'bytes');

  const reader = new FileReader();
  reader.onloadend = () => {
    console.log('✅ Data URL ready, sending to popup for download');
    sendDownloadResponse({ success: true, dataUrl: reader.result, size: finalBlob.size });
  };
  reader.onerror = () => {
    sendDownloadResponse({ success: false, error: 'Failed to read audio data' });
  };
  reader.readAsDataURL(finalBlob);
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