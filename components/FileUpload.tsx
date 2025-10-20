import React, { useCallback, useState } from 'react';
import * as JSZip from 'jszip';
import { UploadCloudIcon } from './icons/UploadCloudIcon';
import { FileTextIcon } from './icons/FileTextIcon';
import { SpinnerIcon } from './icons/SpinnerIcon';
import { ErrorIcon } from './icons/ErrorIcon';

// Inform TypeScript about the pdfjsLib global from the script tag
declare const pdfjsLib: any;
// Configure the worker for pdf.js
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.5.136/pdf.worker.min.mjs`;
}

interface FileUploadProps {
  onFileSelect: (content: string, name: string) => void;
  onProgress: (step: string, percentage: number) => void;
  onParseStart: () => void;
  onParseEnd: () => void;
  disabled: boolean;
  fileName: string;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, onProgress, onParseStart, onParseEnd, disabled, fileName }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState('');

  const parsePdf = async (fileBuffer: ArrayBuffer): Promise<string> => {
    const pdf = await pdfjsLib.getDocument(fileBuffer).promise;
    const numPages = pdf.numPages;
    const textSnippets: string[] = [];
    for (let i = 1; i <= numPages; i++) {
      const percentage = Math.round((i / numPages) * 100);
      onProgress(`Extracting text from page ${i} of ${numPages}...`, percentage);
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      textSnippets.push(pageText);
    }
    return textSnippets.join('\n\n');
  };

  const parsePptx = async (fileBuffer: ArrayBuffer): Promise<string> => {
    onProgress('Loading PPTX file...', 10);
    const zip = await JSZip.loadAsync(fileBuffer);
    const slidePromises: Promise<string>[] = [];
    
    zip.folder('ppt/slides')?.forEach((relativePath, file) => {
        if (relativePath.startsWith('slide') && !relativePath.includes('rels')) {
            slidePromises.push(file.async('string'));
        }
    });
    
    onProgress(`Found ${slidePromises.length} slides, preparing to extract...`, 30);
    const slideXmls = await Promise.all(slidePromises);
    const parser = new DOMParser();
    let fullText = '';
    
    for (let i = 0; i < slideXmls.length; i++) {
        const xmlString = slideXmls[i];
        const percentage = 30 + Math.round(((i + 1) / slideXmls.length) * 70);
        onProgress(`Processing content from slide ${i + 1} of ${slideXmls.length}...`, percentage);

        const doc = parser.parseFromString(xmlString, 'application/xml');
        const textNodes = doc.querySelectorAll('a\\:t');
        textNodes.forEach(node => {
            if (node.textContent) {
                fullText += node.textContent + ' ';
            }
        });
        fullText += '\n';
    }
    return fullText.trim();
  };

  const handleFileChange = async (file: File | null) => {
    if (!file) return;

    onParseStart();
    setIsParsing(true);
    setParseError('');
    onFileSelect('', ''); // Reset previous file

    try {
        const extension = file.name.split('.').pop()?.toLowerCase() || '';
        let text = '';
        const fileBuffer = await file.arrayBuffer();

        switch (extension) {
            case 'pdf':
                if (typeof pdfjsLib === 'undefined') {
                    throw new Error('PDF library is not loaded. Please check your internet connection and refresh.');
                }
                text = await parsePdf(fileBuffer);
                break;
            case 'pptx':
                text = await parsePptx(fileBuffer);
                break;
            case 'txt':
            case 'md':
                onProgress('Reading text file...', 50);
                text = new TextDecoder().decode(fileBuffer);
                onProgress('File read successfully', 100);
                break;
            default:
                 throw new Error(`Unsupported file type: .${extension}. Please upload a PDF, PPTX, or plain text file.`);
        }
        
        if (!text.trim()) {
          throw new Error("Could not extract any text from the document. The file might be empty, image-based, or corrupted.");
        }
        onFileSelect(text, file.name);

    } catch (err: any) {
        console.error("File parsing error:", err);
        setParseError(err.message || 'An error occurred while parsing the file.');
        onFileSelect('', '');
    } finally {
        setIsParsing(false);
        onParseEnd();
    }
  };

  const onDragEnter = useCallback((e: React.DragEvent<HTMLLabelElement>) => { e.preventDefault(); e.stopPropagation(); if (!disabled) setIsDragging(true); }, [disabled]);
  const onDragLeave = useCallback((e: React.DragEvent<HTMLLabelElement>) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }, []);
  const onDragOver = useCallback((e: React.DragEvent<HTMLLabelElement>) => { e.preventDefault(); e.stopPropagation(); }, []);
  const onDrop = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (!disabled && !isParsing && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  }, [disabled, isParsing]);

  return (
    <div className="w-full">
      <label
        htmlFor="file-upload"
        className={`flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-lg cursor-pointer transition-colors duration-300
        ${disabled || isParsing ? 'bg-slate-700/50 border-slate-600 cursor-not-allowed' : 
           isDragging ? 'bg-sky-900/50 border-sky-400' : 
           'bg-slate-800 hover:bg-slate-700/50 border-slate-600 hover:border-slate-500'}`}
        onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}
      >
        <div className="flex flex-col items-center justify-center pt-5 pb-6">
          {isParsing ? (
            <>
              <SpinnerIcon className="w-10 h-10 mb-3 text-sky-400" />
              <p className="mb-2 text-sm text-slate-300">Parsing document...</p>
              <p className="text-xs text-slate-500">This may take a moment for large files.</p>
            </>
          ) : fileName ? (
            <>
              <FileTextIcon className="w-10 h-10 mb-3 text-emerald-400" />
              <p className="mb-2 text-sm text-slate-300 truncate max-w-xs">
                <span className="font-semibold">File ready:</span> {fileName}
              </p>
              <p className="text-xs text-slate-500">Click or drag to replace</p>
            </>
          ) : (
            <>
              <UploadCloudIcon className="w-10 h-10 mb-3 text-slate-400" />
              <p className="mb-2 text-sm text-slate-400">
                <span className="font-semibold text-sky-400">Click to upload</span> or drag and drop
              </p>
              <p className="text-xs text-slate-500">PDF, PPTX, TXT, or MD files</p>
            </>
          )}
        </div>
        <input 
          id="file-upload" type="file" className="hidden" 
          onChange={(e) => handleFileChange(e.target.files ? e.target.files[0] : null)}
          accept=".pdf,.pptx,.txt,.md"
          disabled={disabled || isParsing} 
        />
      </label>
      {parseError && (
        <div className="mt-4 bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg flex items-center gap-3">
          <ErrorIcon className="h-5 w-5 flex-shrink-0" />
          <span className="text-sm">{parseError}</span>
        </div>
      )}
    </div>
  );
};

export default FileUpload;