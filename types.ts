// Fix: Define the shared types for the application.
export type Template = 'standard' | 'cornell' | 'mindmap' | 'qa';

export interface Section {
  id: string;
  title: string;
  content: string;
}

export interface RevisionSheetData {
  title: string;
  sections: Section[];
}

export interface SavedLesson {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sheetData: RevisionSheetData;
  documentText: string;
  fileName?: string;
  language?: string;
  quizBank?: QuizQuestion[];
  lastQuizGeneratedAt?: number;
}

export type QuizQuestionType = 'single_choice' | 'multi_select' | 'true_false' | 'fill_blank' | 'categorize' | 'sequence' | 'intruder';

export interface QuizSequenceItem {
  id: string;
  label: string;
  correctOrder: number;
  explanation?: string;
}

export interface QuizCategory {
  id: string;
  name: string;
}

export interface QuizClassifiableItem {
  id: string;
  label: string;
  correctCategoryId: string;
  explanation?: string;
}

export interface QuizOption {
  id: string;
  text: string;
  explanation?: string;
  isCorrect: boolean;
}

export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  prompt: string;
  lessonId: string;
  difficulty?: string;
  options?: QuizOption[];
  acceptableAnswers?: string[];
  categories?: QuizCategory[];
  classifiableItems?: QuizClassifiableItem[];
  sequenceItems?: QuizSequenceItem[];
  hint?: string;
  explanation?: string;
  tags?: string[];
}

export interface GenerationSettings {
  // Model name as recognized by the provider (LM Studio/OpenAI-compatible).
  model: string;
  // Base URL for the LM Studio (OpenAI-compatible) server, e.g. http://localhost:1234/v1
  baseUrl?: string;
  // Optional API key if your server requires one (LM Studio typically does not).
  apiKey?: string;
  // Target language (BCP-47 code or readable name) for generated content.
  language?: string;
}
