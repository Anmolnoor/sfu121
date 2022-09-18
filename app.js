import Express from "express";
import mediasoup from "mediasoup";
import Https from "httpolyglot";
import { Server } from "socket.io";
import Fs from "fs";
import path from "path";
import { SocketAddress } from "net";

const app = Express();
const __dirname = path.resolve();

app.get("/", (req, res) => {
  res.send("Hello, World!! from mediaSoup Server");
});

app.use("/sfu", Express.static(path.join(__dirname, "public")));

const options = {
  key: Fs.readFileSync(path.join(__dirname, "/server/ssl/", "keytmp.pem")),
  cert: Fs.readFileSync(path.join(__dirname, "/server/ssl/", "cert.pem")),
  passphrase: "root"
};

const httpsServer = Https.createServer(options, app);
httpsServer.listen(3000, () => {
  console.log("Server is running on port 3000");
});

const io = new Server(httpsServer);
const peers = io.of("/mediasoup");

let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999
  });
  console.log("worker created, PID: ", worker.pid);

  worker.on("died", () => {
    console.error(
      "mediasoup worker died, exiting in 2 seconds... [pid:%d]",
      worker.pid
    );
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
};

worker = createWorker();

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000
    }
  }
];

peers.on("connection", async (socket) => {
  console.log("socket connected");
  console.log(socket.id);
  try {
    socket.emit("welcome", "Welcome to MediaSoup Server");
    socket.emit("connection-success", { socketId: socket.id });
    socket.on("disconnect", () => {
      console.log("socket disconnected");
    });

    router = await worker.createRouter({
      mediaCodecs
    });

    socket.on("getRtpCapabilities", async (callback) => {
      const rtpCapabilities = router.rtpCapabilities;

      console.log("rtp Capabilities", { rtpCapabilities });

      // call callback from the client and send back the rtpCapabilities
      callback({ rtpCapabilities });
    });

    const createWebRtcTransport = async (callback) => {
      try {
        const webRtcTransport_options = {
          listenIps: [
            {
              ip: "127.0.0.1"
            }
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true
        };

        let transport = await router.createWebRtcTransport(
          webRtcTransport_options
        );

        console.log("transport created", transport.id);

        transport.on("dtlsstatechange", (dtlsState) => {
          if (dtlsState === "closed") {
            transport.close();
          }

          transport.on("close", () => {
            console.log("transport closed");
          });
        });
        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters
          }
        });

        return transport;
      } catch (error) {
        console.log(error);
        callback({
          params: {
            error: error
          }
        });
      }
    };

    socket.on("createWebRtcTransport", async ({ sender }, callback) => {
      console.log("createWebRtcTransport", sender);
      if (sender) {
        producerTransport = await createWebRtcTransport(callback);
      } else {
        consumerTransport = await createWebRtcTransport(callback);
      }
    });

    socket.on("transport-connect", async ({ dtlsParameters }) => {
      console.log("transport-connect -- DTLD PARAMS", dtlsParameters);

      await producerTransport.connect({ dtlsParameters });
    });

    socket.on(
      "transport-produce",
      async ({ kind, rtpParameters, appData }, callback) => {
        producer = await producerTransport.produce({
          kind,
          rtpParameters
        });

        console.log("producer created", producer.id, producer.kind);

        producer.on("transportclose", () => {
          console.log("transport close");
        });

        callback({ id: producer.id });
      }
    );

    socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
      console.log("transport-connect -- DTLD PARAMS", dtlsParameters);

      await consumerTransport.connect({ dtlsParameters });
    });

    socket.on("consume", async ({ rtpCapabilities }, callback) => {
      try {
        if (router.canConsume({ producerId: producer.id, rtpCapabilities })) {
          consumer = await consumerTransport.consume({
            producerId: producer.id,
            rtpCapabilities,
            paused: true
          });

          consumer.on("transportclose", () => {
            console.log("transport close from the consumer");
          });

          consumer.on("producerclose", () => {
            console.log("producer close from the consumer");
          });

          console.log("consumer created", consumer.id, consumer.kind);

          callback({
            params: {
              id: consumer.id,
              producerId: producer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              type: "simple"
            }
          });
        }

        socket.on("consumer-resume", async () => {
          console.log("consumer-resume");
          await consumer.resume();
        });
      } catch (error) {
        console.log(error);
        callback({
          params: {
            error
          }
        });
      }
    });
  } catch (error) {
    console.log(error);
  }
});
