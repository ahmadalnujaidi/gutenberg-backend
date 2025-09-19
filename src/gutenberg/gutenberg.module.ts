import { Module } from '@nestjs/common';
import { GutenbergService } from './gutenberg.service';
import { GutenbergController } from './gutenberg.controller';
import { GutenbergGateway } from './gutenberg.gateway';

@Module({
  controllers: [GutenbergController],
  providers: [GutenbergService, GutenbergGateway],
})
export class GutenbergModule {}
