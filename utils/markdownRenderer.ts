// Fix: Implement the markdownRenderer utility.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export const renderMarkdown = (markdownText: string): string => {
  if (!markdownText) return '';

  let processedText = markdownText;

  // Pre-process custom tags before sending to marked
  // Using [\s\S]*? to capture multiline content non-greedily
  processedText = processedText.replace(/!def\[([\s\S]*?)\]/g, 
    `<div class="custom-highlight-blue"><strong class="text-sky-300">Definition:</strong> $1</div>`);

  processedText = processedText.replace(/!imp\[([\s\S]*?)\]/g, 
    `<div class="custom-highlight-yellow"><strong class="text-amber-300">Important:</strong> $1</div>`);

  processedText = processedText.replace(/!formula\[([\s\S]*?)\]/g, 
    `<div class="custom-formula-box">$1</div>`);
  
  // Set options for Marked
  marked.setOptions({
    gfm: true,
    breaks: true,
    pedantic: false,
  });

  // Parse the result with marked. It will treat our injected HTML as-is and parse markdown around it.
  const rawHtml = marked.parse(processedText);
  
  // Sanitize the final HTML, ensuring our custom classes are allowed.
  const sanitizedHtml = DOMPurify.sanitize(rawHtml as string, {
      ADD_ATTR: ['class'],
  });

  return sanitizedHtml;
};