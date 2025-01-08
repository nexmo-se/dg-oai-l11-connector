'use strict'

//-------------

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser')
const webSocket = require('ws');
const app = express();
require('express-ws')(app);
app.use(bodyParser.json());
const { Readable } = require('stream');

const fsp = require('fs').promises;
const moment = require('moment');

//---- CORS policy - Update this section as needed ----

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "OPTIONS,GET,POST,PUT,DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");
  next();
});

//--- Audio silence payload for linear 16, 16 kHz, mono ---

const hexSilencePayload = "f8ff".repeat(320);
const silenceAudioPayload = Buffer.from(hexSilencePayload, "hex"); // 640-byte payload for silence - 16 bits - 16 kHz - PCM

//---- DeepGram ASR engine ----

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const fetch = require("cross-fetch");
const dgApiKey = process.env.DEEPGRAM_API_KEY;

//---- OpenAI Chat engine ----

const OpenAI = require("openai");
const oaiKey = process.env.OPENAI_API_KEY;
const oaiModel = process.env.OPENAI_MODEL;
const oaiSystemMessage = process.env.OPENAI_SYSTEM_MESSAGE;

//---- ElevenLabs TTS engine ----

const { ElevenLabsClient } = require("elevenlabs");
// const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID;
const elevenLabsModel = process.env.ELEVENLABS_MODEL;
const elevenLabsTtsUrl = process.env.ELEVENLABS_TTS_BASE_URL;
const elevenLabs = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY
});

//--

function streamToArrayBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    readableStream.on('end', () => {
      resolve(Buffer.concat(chunks).buffer);
    });
    readableStream.on('error', reject);
  });
}

//--- Websocket server (for WebSockets from Vonage Voice API platform) ---

app.ws('/socket', async (ws, req) => {

  const peerUuid = req.query.peer_uuid;
  const ttsLanguageCode = req.query.elevenlabs_tts_language_code || 'en';
  const ttsVoice = req.query.elevenlabs_tts_voice || 'Aria';

  console.log('WebSocket from Vonage platform')
  console.log('peer call uuid:', peerUuid);

  let wsVgOpen = true; // WebSocket to Vonage ready for binary audio payload?
  let shutDownWs = false; // Shut down this WebSocket because of error (e.g. invalid requested language code)

  //-- audio recording files -- 
  const audioFromVgFileName = './recordings/' + peerUuid + '_rec_from_vg_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time
  const audioToDgFileName = './recordings/' + peerUuid + '_rec_to_dg_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time
  const audioFrom11LFileName = './recordings/' + peerUuid + '_rec_from_11l_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time
  const audioToVgFileName = './recordings/' + peerUuid + '_rec_to_vg_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time

  let file;

  try {
    file = await fsp.writeFile(audioFromVgFileName, '');
  } catch(e) {
    console.log("Error creating file", audioFromVgFileName, e);
  }
  console.log('File created:', audioFromVgFileName);

  // try {
  //   file = await fsp.writeFile(audioToDgFileName, '');
  // } catch(e) {
  //   console.log("Error creating file", audioToDgFileName, e);
  // }
  // console.log('File created:', audioToDgFileName);

  try {
    file = await fsp.writeFile(audioFrom11LFileName, '');
  } catch(e) {
    console.log("Error creating file", audioFrom11LFileName, e);
  }
  console.log('File created:', audioFrom11LFileName);

  // try {
  //   file = await fsp.writeFile(audioToVgFileName, '');
  // } catch(e) {
  //   console.log("Error creating file", audioToVgFileName, e);
  // }
  // console.log('File created:', audioToVgFileName);

  //-- how to write audio payload into file --
  //   try {
  //     fsp.appendFile(filename, msg, 'binary');
  //   } catch(e) {
  //     console.log("error writing to file", filename, e);
  //   }

  //-- stream audio to VG --

  let elevenLabsPayload = Buffer.alloc(0);
  let streamToVgIndex = 0;

  const streamTimer = setInterval ( () => {

    if (elevenLabsPayload.length != 0) {

      const streamToVgPacket = Buffer.from(elevenLabsPayload).subarray(streamToVgIndex, streamToVgIndex + 640);  // 640-byte packet for linear16 / 16 kHz
      streamToVgIndex = streamToVgIndex + 640;

      if (streamToVgPacket.length != 0) {
        if (wsVgOpen && streamToVgPacket.length == 640) {
            ws.send(streamToVgPacket);

            try {
              fsp.appendFile(audioToVgFileName, streamToVgPacket, 'binary');
            } catch(e) {
              console.log("error writing to file", audioToVgFileName, e);
            }

        };
      } else {
        streamToVgIndex = streamToVgIndex - 640; // prevent index from increasing for ever as it is beyond buffer current length
        ws.send(silenceAudioPayload);
      }

    }  

  }, 20);
  
  //-- OpenAI connection ---

  const openAi = new OpenAI();

  //-- Deepgram connection ---

  console.log('Opening client connection to DeepGram');

  const deepgramClient = createClient(dgApiKey);

  let deepgram = deepgramClient.listen.live({       
    model: "nova-2",
    smart_format: true,      
    language: "en-US",        
    encoding: "linear16",
    sample_rate: 16000
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram: connected");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, async (data) => {
      // console.log(JSON.stringify(data));
      const transcript = data.channel.alternatives[0].transcript;

      if (transcript != '') {

        // barge-in handling
        elevenLabsPayload = Buffer.alloc(0);  // reset stream buffer to VG
        streamToVgIndex = 0; 

        console.log('\n>>> Deepgram transcript:');
        console.log(transcript);

        //-- send to OpenAI
        const completion = await openAi.chat.completions.create({
            model: oaiModel,
            messages: [
                { role: "developer", content: oaiSystemMessage },
                {
                    role: "user",
                    content: transcript,
                },
            ],
        });

        console.log('\n>>> OpenAI response:');
        // console.log(completion);
        // console.log(completion.choices[0]);
        // console.log(completion.choices[0].message);
        // console.log(completion.choices[0].message.content);

        const oAiTextResponse = completion.choices[0].message.content;
        console.log('>>> OpenAI response:', oAiTextResponse);

        //-- send OpenAI reply to ElevenLabs

        let elevenLabsResponse;

        try {
          elevenLabsResponse = await elevenLabs.generate({
              stream: true,
              voice: ttsVoice,
              text: oAiTextResponse,
              model_id: elevenLabsModel,
              output_format: "pcm_16000",
              language_code: ttsLanguageCode
          });
        } catch (error) {
          console.error('Error generating ElevenLabs TTS audio:', error);
          console.error('Check parameters and arguments on the request to ElevenLabs, e.g. valid language code, etc, ?');
          console.error('Now closing WebSocket because of above error ....');

          // close all connections
          shutDownWs = true;
          wsVgOpen = false;
          ws.close(); // close this websocket
        }

        //--

        if (!shutDownWs) {

          const elevenLabsReadableStream = Readable.from(elevenLabsResponse);
          
          const elevenLabsAudioArrayBuffer = await streamToArrayBuffer(elevenLabsReadableStream);

          const ttsAudioPayload = Buffer.from(elevenLabsAudioArrayBuffer);

          console.log('\n>>>', Date.now(), '11Labs TTS audio payload length:', ttsAudioPayload.length);

          //-- write payload into audio file --    
          try {
            fsp.appendFile(audioFrom11LFileName, ttsAudioPayload, 'binary');
          } catch(e) {
            console.log("error writing to file", audioFrom11LFileName, e);
          } 

          if(wsVgOpen) {
            elevenLabsPayload = Buffer.concat([elevenLabsPayload, ttsAudioPayload]);
          }

          // if (wsVgOpen) {
          //   ws.send(ttsAudioPayload);
          // }

          // if (wsVgOpen) {
          //   ws.send(Buffer.from(elevenLabsResponse));
          // }
        }  

      }   

    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram: disconnected");
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram: metadata received");
      console.log("ws: metadata sent to client");
      // ws.send(JSON.stringify({ metadata: data }));
      console.log(JSON.stringify({ metadata: data }));
    });
  
  });

  //---------------

  ws.on('message', async (msg) => {
    
    if (typeof msg === "string") {
    
      console.log("\n>>> Websocket text message:", msg);
    
    } else {

      if (deepgram.getReadyState() === 1 /* OPEN */) {
        deepgram.send(msg);
      } else if (deepgram.getReadyState() >= 2 /* 2 = CLOSING, 3 = CLOSED */) {
        // console.log("ws: data couldn't be sent to deepgram");
        null
      } else {
        // console.log("ws: data couldn't be sent to deepgram");
        null
      }

    }

  });

  //--

  ws.on('close', async () => {

    wsVgOpen = false;

    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
    
    console.log("Vonage WebSocket closed");
  });

});

//--- If this application is hosted on VCR (Vonage Code Runtime) serverless infrastructure (aka Neru) --------

app.get('/_/health', async(req, res) => {

  res.status(200).send('Ok');

});

//=========================================

const port = process.env.NERU_APP_PORT || process.env.PORT || 6000;

app.listen(port, () => console.log(`Connector application listening on port ${port}`));

//------------

