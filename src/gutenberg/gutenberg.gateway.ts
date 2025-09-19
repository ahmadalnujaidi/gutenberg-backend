import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
  } from '@nestjs/websockets';
  import { Server, Socket } from 'socket.io';
  
  export interface StreamingUpdate {
    type: 'batch_complete' | 'analysis_complete' | 'error' | 'progress';
    batchIndex?: number;
    totalBatches?: number;
    data?: any;
    message?: string;
  }
  
  @WebSocketGateway({
    cors: {
      origin: '*',
    },
    transports: ['websocket', 'polling'],
  })
  export class GutenbergGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;
  
    handleConnection(client: Socket) {
      console.log(`Client connected: ${client.id}`);
    }
  
    handleDisconnect(client: Socket) {
      console.log(`Client disconnected: ${client.id}`);
    }
  
    @SubscribeMessage('join')
    handleJoinRoom(
      @MessageBody() sessionId: string,
      @ConnectedSocket() client: Socket,
    ) {
      console.log(`Client ${client.id} joining room: ${sessionId}`);
      client.join(sessionId);
      client.emit('joined', { sessionId, message: 'Successfully joined room' });
    }
  
    sendBatchUpdate(sessionId: string, update: StreamingUpdate) {
      console.log(`Sending update to room ${sessionId}:`, update.type);
      this.server.to(sessionId).emit('analysis_update', update);
    }
  
    sendToAll(update: StreamingUpdate) {
      this.server.emit('analysis_update', update);
    }
  }