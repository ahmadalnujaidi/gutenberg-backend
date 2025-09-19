import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { GutenbergGateway, StreamingUpdate } from './gutenberg.gateway';

export interface Character {
  name: string;
  mentions: number;
  description: string;
  aliases?: string[]; // Track alternative names
}

export interface Interaction {
  source: string;
  target: string;
  weight: number;
  contexts: string[];
}

export interface AnalysisResult {
  characters: Character[];
  interactions: Interaction[];
}

export interface CharacterRegistry {
  [canonicalName: string]: {
    aliases: string[];
    description: string;
    mentions: number;
  };
}

@Injectable()
export class GutenbergService {
  constructor(private readonly gateway: GutenbergGateway) {}

  private client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  private readonly CHUNK_SIZE = 6000;
  private readonly OVERLAP_SIZE = 300;
  private readonly BATCH_SIZE = 3;

  async createStreaming(sessionId: string, bookID: string): Promise<void> {
    console.log(`Starting enhanced two-pass analysis for session: ${sessionId}`);
    console.log(`Book ID: ${bookID}`);

    try {
      // Phase 1: Fetch book and extract initial character list
      this.gateway.sendBatchUpdate(sessionId, {
        type: 'progress',
        message: '📖 Fetching book and identifying characters...'
      });

      const bookText = await this.fetchBook(bookID);
      const characterRegistry = await this.buildCharacterRegistry(bookText, sessionId);
      
      this.gateway.sendBatchUpdate(sessionId, {
        type: 'progress',
        message: `🎭 Found ${Object.keys(characterRegistry).length} main characters. Starting detailed analysis...`
      });

      // Phase 2: Analyze interactions with consistent character names
      const chunks = this.splitTextIntoChunks(bookText);
      const totalBatches = Math.ceil(chunks.length / this.BATCH_SIZE);
      const allResults: AnalysisResult[] = [];

      for (let i = 0; i < chunks.length; i += this.BATCH_SIZE) {
        const batchIndex = Math.floor(i / this.BATCH_SIZE);
        const batch = chunks.slice(i, i + this.BATCH_SIZE);
        
        this.gateway.sendBatchUpdate(sessionId, {
          type: 'progress',
          message: `📊 Analyzing interactions: Batch ${batchIndex + 1}/${totalBatches}`,
          batchIndex,
          totalBatches
        });

        // Process batch with character registry for consistency
        const batchPromises = batch.map((chunk, idx) => 
          this.analyzeChunkWithRegistry(chunk, i + idx, characterRegistry)
        );
        
        const batchResults = await Promise.all(batchPromises);
        allResults.push(...batchResults);

        // Send incremental update
        const currentMerged = this.mergeResults(allResults, characterRegistry);
        
        this.gateway.sendBatchUpdate(sessionId, {
          type: 'batch_complete',
          batchIndex,
          totalBatches,
          data: {
            ...currentMerged,
            batchIndex,
            totalBatches,
            isComplete: batchIndex === totalBatches - 1
          }
        });

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Final result
      this.gateway.sendBatchUpdate(sessionId, {
        type: 'analysis_complete',
        message: '🎉 Character network analysis complete!',
        data: this.mergeResults(allResults, characterRegistry)
      });

    } catch (error) {
      console.error('Error in enhanced analysis:', error);
      this.gateway.sendBatchUpdate(sessionId, {
        type: 'error',
        message: `Analysis failed: ${error.message}`
      });
    }
  }

  private async fetchBook(bookID: string): Promise<string> {
    console.log(`Fetching book: ${bookID}`);
    const url = `https://www.gutenberg.org/files/${bookID}/${bookID}-0.txt`; // Default to Romeo & Juliet
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch book: ${response.statusText}`);
    }
    return await response.text();
  }

  private async buildCharacterRegistry(text: string, sessionId: string): Promise<CharacterRegistry> {
    // Take samples from beginning, middle, and end of the book for character discovery
    const samples = this.getSampleChunks(text, 3);
    
    this.gateway.sendBatchUpdate(sessionId, {
      type: 'progress',
      message: '🔍 Discovering main characters...'
    });

    const characterDiscoveries = await Promise.all(
      samples.map((sample, index) => this.discoverCharacters(sample, index))
    );

    // Merge and deduplicate character discoveries
    const allCharacters = characterDiscoveries.flat();
    const characterRegistry: CharacterRegistry = {};

    // Group similar names and create canonical entries
    for (const char of allCharacters) {
      const canonicalName = this.getCanonicalName(char.name, characterRegistry);
      
      if (!characterRegistry[canonicalName]) {
        characterRegistry[canonicalName] = {
          aliases: [char.name],
          description: char.description,
          mentions: char.mentions
        };
      } else {
        // Merge with existing entry
        if (!characterRegistry[canonicalName].aliases.includes(char.name)) {
          characterRegistry[canonicalName].aliases.push(char.name);
        }
        characterRegistry[canonicalName].mentions += char.mentions;
        if (char.description.length > characterRegistry[canonicalName].description.length) {
          characterRegistry[canonicalName].description = char.description;
        }
      }
    }

    // Filter to keep only significant characters
    const filteredRegistry: CharacterRegistry = {};
    Object.entries(characterRegistry).forEach(([name, data]) => {
      if (data.mentions >= 3) { // Minimum threshold
        filteredRegistry[name] = data;
      }
    });

    console.log('Character Registry built:', Object.keys(filteredRegistry));
    return filteredRegistry;
  }

  private getSampleChunks(text: string, numSamples: number): string[] {
    const chunkSize = 8000;
    const samples: string[] = [];
    
    // Beginning
    samples.push(text.substring(0, chunkSize));
    
    // Middle samples
    for (let i = 1; i < numSamples - 1; i++) {
      const start = Math.floor((text.length / numSamples) * i);
      samples.push(text.substring(start, start + chunkSize));
    }
    
    // End
    samples.push(text.substring(Math.max(0, text.length - chunkSize)));
    
    return samples;
  }

  private async discoverCharacters(chunk: string, chunkIndex: number): Promise<Character[]> {
    const prompt = `
    Analyze this text sample and identify ALL MAIN CHARACTERS. Focus on:
    1. Named individuals (not generic titles like "soldier" or "messenger")
    2. Characters who speak dialogue or perform actions
    3. Provide the MOST COMMON name/title for each character
    4. Include important titles (e.g., "Lady Capulet" not just "Capulet")

    Return ONLY valid JSON:
    {
      "characters": [
        {"name": "Romeo Montague", "mentions": 12, "description": "Young Montague heir, protagonist"},
        {"name": "Lady Capulet", "mentions": 8, "description": "Juliet's mother, Capulet family matriarch"}
      ]
    }

    Text sample: ${chunk}
    `;

    try {
      const completion = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system", 
            content: "You are a literary analysis expert specializing in character identification. Always return valid JSON with consistent character names."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 1000,
        response_format: { type: "json_object" }
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error('No response from OpenAI');

      const result = JSON.parse(content);
      return result.characters || [];
    } catch (error) {
      console.error(`Error discovering characters in chunk ${chunkIndex}:`, error);
      return [];
    }
  }

  private getCanonicalName(name: string, existingRegistry: CharacterRegistry): string {
    const cleanName = name.trim();
    
    // Check if this name is similar to any existing canonical names
    for (const [canonicalName, data] of Object.entries(existingRegistry)) {
      // Check if it's an exact match with any alias
      if (data.aliases.some(alias => 
        alias.toLowerCase() === cleanName.toLowerCase()
      )) {
        return canonicalName;
      }
      
      // Check if it's a partial match (e.g., "Capulet" vs "Lady Capulet")
      if (this.areNamesSimilar(cleanName, canonicalName)) {
        // Prefer the longer, more specific name
        return cleanName.length > canonicalName.length ? cleanName : canonicalName;
      }
    }
    
    return cleanName; // New canonical name
  }

  private areNamesSimilar(name1: string, name2: string): boolean {
    const n1 = name1.toLowerCase();
    const n2 = name2.toLowerCase();
    
    // Same name
    if (n1 === n2) return true;
    
    // One contains the other (e.g., "Capulet" and "Lady Capulet")
    if (n1.includes(n2) || n2.includes(n1)) return true;
    
    // Check if they share significant words
    const words1 = n1.split(' ').filter(w => w.length > 2);
    const words2 = n2.split(' ').filter(w => w.length > 2);
    
    return words1.some(w1 => words2.some(w2 => w1 === w2));
  }

  private async analyzeChunkWithRegistry(
    chunk: string, 
    chunkIndex: number, 
    characterRegistry: CharacterRegistry
  ): Promise<AnalysisResult> {
    const characterList = Object.keys(characterRegistry)
      .map(name => `${name} (aliases: ${characterRegistry[name].aliases.join(', ')})`)
      .join('\n');

    const prompt = `
    Analyze this text for character interactions. Use ONLY the character names from this registry:

    KNOWN CHARACTERS:
    ${characterList}

    Rules:
    1. Only identify interactions between characters from the registry above
    2. Use the EXACT canonical names from the registry
    3. If you see an alias, map it to the canonical name
    4. Ignore characters not in the registry
    5. Rate interaction strength 1-10 based on dialogue, actions, and emotional significance

    Return ONLY valid JSON:
    {
      "characters": [
        {"name": "Romeo Montague", "mentions": 5, "description": "Young lover, conflicted"}
      ],
      "interactions": [
        {"source": "Romeo Montague", "target": "Lady Capulet", "weight": 7, "contexts": ["confrontation scene"]}
      ]
    }

    Text: ${chunk}
    `;

    try {
      const completion = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system", 
            content: "You are a literary analysis expert. Use ONLY the provided character registry. Always return valid JSON with exact canonical names."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: "json_object" }
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error('No response from OpenAI');

      return JSON.parse(content) as AnalysisResult;
    } catch (error) {
      console.error(`Error analyzing chunk ${chunkIndex}:`, error);
      return { characters: [], interactions: [] };
    }
  }

  private mergeResults(results: AnalysisResult[], characterRegistry: CharacterRegistry): AnalysisResult {
    const characterMap = new Map<string, Character>();
    const interactionMap = new Map<string, Interaction>();

    // Initialize characters from registry
    Object.entries(characterRegistry).forEach(([canonicalName, data]) => {
      characterMap.set(canonicalName, {
        name: canonicalName,
        mentions: 0,
        description: data.description,
        aliases: data.aliases
      });
    });

    // Merge character mentions
    for (const result of results) {
      for (const char of result.characters) {
        const existing = characterMap.get(char.name);
        if (existing) {
          existing.mentions += char.mentions || 1;
          if ((char.description?.length || 0) > existing.description.length) {
            existing.description = char.description;
          }
        }
      }
    }

    // Merge interactions
    for (const result of results) {
      for (const interaction of result.interactions) {
        // Validate both characters exist in registry
        if (!characterMap.has(interaction.source) || !characterMap.has(interaction.target)) {
          continue;
        }
        
        const key = `${interaction.source}-${interaction.target}`;
        const existing = interactionMap.get(key);
        
        if (existing) {
          existing.weight += interaction.weight;
          existing.contexts.push(...interaction.contexts);
          existing.contexts = [...new Set(existing.contexts)];
        } else {
          interactionMap.set(key, { ...interaction });
        }
      }
    }

    // Filter out characters with no mentions
    const activeCharacters = Array.from(characterMap.values())
      .filter(char => char.mentions > 0)
      .sort((a, b) => b.mentions - a.mentions);

    return {
      characters: activeCharacters,
      interactions: Array.from(interactionMap.values())
        .sort((a, b) => b.weight - a.weight)
    };
  }

  // Keep existing helper methods
  splitTextIntoChunks(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + this.CHUNK_SIZE;
      
      if (end < text.length) {
        const lastSentence = text.lastIndexOf('.', end);
        const lastParagraph = text.lastIndexOf('\n\n', end);
        const breakPoint = Math.max(lastSentence, lastParagraph);
        
        if (breakPoint > start + this.CHUNK_SIZE * 0.7) {
          end = breakPoint + 1;
        }
      }

      chunks.push(text.slice(start, end));
      start = end - this.OVERLAP_SIZE;
    }

    return chunks;
  }
}