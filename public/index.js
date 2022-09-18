const io = require("socket.io-client");
const mediaSoupClient = require("mediasoup-client");

const socket = io("/mediasoup");

socket.on("connection-success", (socketId, existsProducer) => {
  console.log("connection successful", socketId, existsProducer);
});

let device;

let producerTransport;
let producer;

let consumerTransport;
let consumer;

let isProducer = false;

let rtpCapabilities;

let params = {
  // mediaSoup params
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "S1T3"
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "S1T3"
    },
    {
      rid: "r2",
      maxBitrate: 900000,
      scalabilityMode: "S1T3"
    }
  ],
  codecOptions: {
    videoGoogleStartBitrate: 1000
  }
};

//  get Local Stream onClick

const streamSuccess = (stream) => {
  localVideo.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  params = {
    track,
    ...params
  };
  goConnect(true);
};

const getLocalStream = () => {
  navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: {
        width: {
          min: 640,
          max: 1920
        },
        height: {
          min: 480,
          max: 1080
        }
      }
    })
    .then(streamSuccess)
    .catch((err) => console.log(err));
};

const goConnect = (producerOrConsumer) => {
  isProducer = producerOrConsumer;
  device === undefined ? getRtpCapabilities() : goCreateTransport();
};

const goConsume = () => {
  goConnect(false);
};

// create device and get the rtp capabilities
const getRtpCapabilities = () => {
  socket.emit("createRoom", (data) => {
    console.log(`Router RTP Capabilities...New Room:  ${data.rtpCapabilities}`);
    rtpCapabilities = data.rtpCapabilities;
    createDevice();
  });
};

const goCreateTransport = () => {
  if (isProducer) {
    createSendTransport();
  } else {
    createRecvTransport();
  }
};

// create new device
const createDevice = async () => {
  try {
    device = new mediaSoupClient.Device();
    console.log(rtpCapabilities);
    await device.load({
      routerRtpCapabilities: rtpCapabilities
    });

    goCreateTransport();
  } catch (error) {
    console.log(error);
    if (error.name === "UnsupportedError") {
      console.error("browser not supported");
    }
  }
};

const createSendTransport = async () => {
  socket.emit("createWebRtcTransport", { sender: true }, ({ params }) => {
    if (params.error) {
      console.log(params.error);
      return;
    }
    console.log("createWebRtcTransport");
    console.log(params);

    producerTransport = device.createSendTransport(params);

    producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          await socket.emit("transport-connect", {
            dtlsParameters
          });

          callback();
        } catch (error) {
          errback(error);
        }
      }
    );

    producerTransport.on("produce", async (parameters, callback, errback) => {
      console.log({ parameters });

      try {
        await socket.emit(
          "transport-produce",
          {
            kind: parameters.kind,
            rtpParameters: parameters.rtpParameters,
            appData: parameters.appData
          },
          ({ id }) => {
            callback({ id });
          }
        );
      } catch (error) {
        errback(error);
      }
    });

    connectSendTransport();
  });
};

const connectSendTransport = async () => {
  producer = await producerTransport.produce(params);

  producer.on("trackended", () => {
    console.log("track ended");

    // close video track
  });

  producer.on("transportclose", () => {
    console.log("transport ended");
  });
};

const createRecvTransport = async () => {
  await socket.emit(
    "createWebRtcTransport",
    { sender: false },
    ({ params }) => {
      if (params.error) {
        console.log(params.error);
        return;
      }

      console.log("createWebRtcTransport", params);

      consumerTransport = device.createRecvTransport(params);

      consumerTransport.on(
        "connect",
        async ({ dtlsParameters }, callback, errback) => {
          try {
            await socket.emit("transport-recv-connect", {
              dtlsParameters
            });

            callback();
          } catch (error) {
            errback(error);
          }
        }
      );
      connectRecvTransport();
    }
  );
};

const connectRecvTransport = async (consumerParameters) => {
  await socket.emit(
    "consume",
    {
      rtpCapabilities: device.rtpCapabilities
    },
    async ({ params }) => {
      if (params.error) {
        console.log(params.error);
        return;
      }

      console.log("consume", params);

      const consumer = await consumerTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters
      });

      const { track } = consumer;

      remoteVideo.srcObject = new MediaStream([track]);

      socket.emit("consumer-resume");
    }
  );
};

btnLocalVideo.addEventListener("click", getLocalStream);
btnRecvSendTransport.addEventListener("click", goConsume);
