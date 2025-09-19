import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { GutenbergService } from './gutenberg.service';


@Controller('gutenberg')
export class GutenbergController {
  constructor(private readonly gutenbergService: GutenbergService) {}

  
  @Post('analyze-streaming')
  async analyzeStreaming(@Body() body: { sessionId: string, bookID: string }) {
    const sessionId = body.sessionId || `session_${Date.now()}`;

    const bookID = body.bookID;
    
    // Start streaming analysis (non-blocking)
    this.gutenbergService.createStreaming(sessionId, bookID);
    
    return { 
      message: 'Analysis started', 
      sessionId,
      instructions: 'Connect to WebSocket to receive real-time updates'
    };
  }
}