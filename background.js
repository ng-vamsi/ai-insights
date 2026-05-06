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
  
  // Handle AI summary generation request
  if (message.type === 'GENERATE_AI_SUMMARY') {
    handleGenerateAISummary(message.transcript);
    return false;
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
    // Don't specify encoding - let Deepgram auto-detect the WebM format
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?` + new URLSearchParams({
      model: 'nova-2',
      language: 'en',
      punctuate: 'true',
      interim_results: 'true',
      smart_format: 'true',
      // Don't specify encoding - Deepgram will auto-detect WebM/Opus
      // sentiment: 'true',  // Note: sentiment might not be available in your plan
      // detect_topics: 'true',  // Note: topics might not be available in your plan
      // intents: 'true',  // Note: intents might not be available in your plan
      diarize: 'true'
    }).toString();
    
    console.log('🔗 Connecting to:', deepgramUrl);
    console.log('🔑 API Key length:', deepgramApiKey?.length);
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
              // Store final transcript for insights
              fullTranscript.push({
                text: transcript,
                timestamp: Date.now(),
                sentiment: sentiment,
                speaker: data.channel.alternatives[0].words?.[0]?.speaker
              });
              
              if (sentiment) sentimentData.push(sentiment);
              if (topics.length > 0) detectedTopics.push(...topics);
              if (intents.length > 0) detectedIntents.push(...intents);
              
              console.log('📊 Stored transcript segment:', { sentiment, topics, intents });
              
              // Generate and send live insights
              const liveInsights = generateLiveInsights();
              chrome.runtime.sendMessage({
                type: 'LIVE_INSIGHTS_UPDATE',
                data: liveInsights
              }).catch(() => {});
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
      console.error('❌ Socket readyState:', deepgramSocket?.readyState);
      console.error('❌ Socket url:', deepgramSocket?.url);
      deepgramConnected = false;
      
      chrome.runtime.sendMessage({
        type: 'TRANSCRIPTION_ERROR',
        error: 'WebSocket connection error - check API key and network'
      }).catch(() => {});
    };
    
    deepgramSocket.onclose = (event) => {
      console.log('🔌 Deepgram WebSocket closed');
      console.log('Close code:', event.code, 'Reason:', event.reason);
      console.log('Was clean:', event.wasClean);
      deepgramConnected = false;
      
      if (event.code !== 1000 && event.code !== 1005) {
        // Not a normal close
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
  
  // Count questions
  const questions = fullTranscript.filter(t => t.text.includes('?')).length;
  
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
    topics: [...new Set(detectedTopics)].slice(0, 5)
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
  const wordCount = fullText.split(/\s+/).length;
  
  // Count questions
  const questions = fullTranscript.filter(t => t.text.includes('?')).length;
  
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
  
  // Detect action items (sentences with action verbs)
  const actionVerbs = ['need', 'should', 'must', 'will', 'going to', 'have to', 'plan', 'schedule'];
  const actionItems = fullTranscript
    .filter(t => actionVerbs.some(verb => t.text.toLowerCase().includes(verb)))
    .map(t => t.text)
    .slice(0, 5);
  
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
  
  return {
    summary,
    fullText, // Include for AI analysis
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
    topics: [...new Set(detectedTopics)].slice(0, 5),
    keyPhrases,
    actionItems,
    speakerStats: speakers
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
          content: `You are an expert sales conversation analyst. Analyze the transcript and provide a comprehensive assessment:

1. BUYER INTENT & READINESS (0-100% score):
   - How ready is the prospect to buy?
   - What stage of the buying journey are they in?
   
2. KEY INSIGHTS:
   - Customer's main pain points and challenges
   - Buying signals detected (timeline questions, budget mentions, etc.)
   - Objections raised and their severity
   
3. EMOTIONAL ANALYSIS:
   - Prospect's emotional state (enthusiastic, cautious, skeptical, etc.)
   - Level of engagement and interest
   
4. RECOMMENDATIONS:
   - What should the sales person do next?
   - Which objections need addressing?
   - Suggested follow-up actions
   
5. DEAL HEALTH:
   - Overall assessment: Strong/Medium/Weak
   - Risk factors
   - Opportunities

Be specific, actionable, and reference actual statements from the conversation.`
        }, {
          role: 'user',
          content: `Analyze this sales conversation:\n\n${transcript}`
        }],
        max_tokens: 800,
        temperature: 0.7
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