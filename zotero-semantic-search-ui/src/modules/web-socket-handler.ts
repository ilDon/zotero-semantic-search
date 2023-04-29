import { Socket } from "socket.io-client";
import { io } from "socket.io-client";
import { BASE_URL } from './api';

export class WebSocketHandler {
  private socket: Socket;

  constructor(onProgress: (progress: number) => void) {
    this.socket = io(BASE_URL); // Replace with the appropriate Flask-SocketIO server address

    this.socket.on("progress", (data: string) => {
      const parsedData = JSON.parse(data) as { progress: number };
      const progress = parsedData.progress;
      onProgress(progress);
    });

    this.socket.on("connect_error", (error: Error) => {
      console.error("Socket.IO connection error:", error);
    });

    this.socket.on("disconnect", () => {
      console.log("Socket.IO disconnected.");
    });
  }

  close(): void {
    this.socket.disconnect();
  }
}