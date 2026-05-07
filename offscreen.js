// offscreen.js
console.log('🎬 Offscreen document loaded and ready!');

// Global references for stopping recording
let currentMediaRecorder = null;
let currentAudioContext = null;
let currentStreams = [];

// Listen for the start signal from the background script
chrome.runtime.onMessage.addListener(async (message) => {
    console.log('📨 Message received in offscreen:', {message} )

  if (message.target === 'offscreen' && message.type === 'START_RECORDING') {
    console.log('🎯 Starting capture with data:', message.data);
    startCapture(message.data);
  } else if (message.target === 'offscreen' && message.type === 'STOP_RECORDING') {
    console.log('🛑 Stop recording requested');
    stopCapture();
  } else {
    console.log('⚠️ Message ignored (wrong target or type)');
  }
});

async function startCapture(data) {
    console.log('🎙️ Inside startCapture function', {data} )

  const { streamId, tabId } = data;

  try {
    console.log('📺 Attempting to capture tab audio with streamId:', streamId);
    
    // 1. Capture the Tab Audio (The Prospect)
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
    console.log('✅ Tab audio stream captured:', tabStream);

    // 2. Capture the Microphone (The Salesperson)
    console.log('🎤 Attempting to capture microphone...');
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('✅ Microphone stream captured:', micStream);
    } catch (micError) {
      console.error('❌ Microphone capture failed:', micError);
      console.error('Microphone error details:', {
        name: micError.name,
        message: micError.message
      });
      
      // Continue without microphone (tab audio only)
      console.warn('⚠️ Continuing with tab audio only (no microphone)');
      micStream = null;
    }

    // 3. Mix the Streams using Web Audio API
    console.log('🎚️ Creating audio context and mixing streams...');
    const audioContext = new AudioContext();
    currentAudioContext = audioContext; // Store for cleanup
    
    // Store streams for cleanup
    currentStreams = [tabStream];
    if (micStream) {
      currentStreams.push(micStream);
    }
    
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    
    // Only create mic source if we have a mic stream
    let micSource = null;
    if (micStream) {
      micSource = audioContext.createMediaStreamSource(micStream);
      console.log('🔊 Audio sources created (with mic):', { tabSource, micSource, streamId });
    } else {
      console.log('🔊 Audio source created (tab only):', { tabSource, streamId });
    }
    
    const mixedDestination = audioContext.createMediaStreamDestination();

    // Connect both sources to the mixer
    tabSource.connect(mixedDestination);
    if (micSource) {
      micSource.connect(mixedDestination);
      console.log('✅ Both tab and mic connected to mixer');
    } else {
      console.log('✅ Only tab connected to mixer');
    }

    // IMPORTANT: Connect tabSource to hardware speakers so YOU can still hear the call
    tabSource.connect(audioContext.destination);

    // 4. Record the mixed stream
    console.log('🎙️ Creating MediaRecorder...');
    const mediaRecorder = new MediaRecorder(mixedDestination.stream, {
      mimeType: 'audio/webm;codecs=opus'
    });
    currentMediaRecorder = mediaRecorder;
    
    mediaRecorder.onerror = (event) => {
      console.error('❌ MediaRecorder error:', event.error);
    };

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        console.log('📤 Audio chunk ready - Size:', event.data.size, 'bytes');
        
        event.data.arrayBuffer().then(arrayBuffer => {
          const uint8Array = new Uint8Array(arrayBuffer);
          const regularArray = Array.from(uint8Array);
          
          chrome.runtime.sendMessage({
            type: 'AUDIO_DATA_CHUNK',
            payload: {
              data: regularArray,
              size: event.data.size,
              mimeType: event.data.type
            }
          }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('❌ Failed to send chunk:', chrome.runtime.lastError.message);
            }
          });
        }).catch(err => {
          console.error('❌ Error converting blob to array:', err.message);
        });
      } else {
        console.warn('⚠️ Empty audio chunk received');
      }
    };

    // Collect data every 1 second (ideal for real-time transcription)
    console.log('▶️ Recording started - collecting audio every 1 second');
    mediaRecorder.start(1000); 

  } catch (err) {
    console.error('❌ Error capturing audio:', err);
    console.error('Error details:', {
      name: err.name,
      message: err.message,
      stack: err.stack
    });
  }
}

function stopCapture() {
  console.log('🛑 Stopping audio capture...');
  
  try {
    // Stop MediaRecorder
    if (currentMediaRecorder && currentMediaRecorder.state !== 'inactive') {
      currentMediaRecorder.stop();
      console.log('✅ MediaRecorder stopped');
    }
    
    // Stop all audio tracks
    currentStreams.forEach((stream, index) => {
      stream.getTracks().forEach(track => {
        track.stop();
        console.log(`✅ Track ${index + 1} stopped:`, track.kind);
      });
    });
    
    // Close audio context
    if (currentAudioContext && currentAudioContext.state !== 'closed') {
      currentAudioContext.close();
      console.log('✅ AudioContext closed');
    }
    
    // Clear references
    currentMediaRecorder = null;
    currentAudioContext = null;
    currentStreams = [];
    
    console.log('✅ All audio resources released');
  } catch (err) {
    console.error('❌ Error stopping capture:', err);
  }
}