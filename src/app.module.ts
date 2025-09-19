import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GutenbergModule } from './gutenberg/gutenberg.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [GutenbergModule,
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
