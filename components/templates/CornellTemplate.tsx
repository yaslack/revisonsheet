// Fix: Implement the CornellTemplate component.
import React from 'react';
import { RevisionSheetData } from '../../types';
import { renderMarkdown } from '../../utils/markdownRenderer';

interface TemplateProps {
  sheetData: RevisionSheetData;
}

export const CornellTemplate: React.FC<TemplateProps> = ({ sheetData }) => {
  return (
    <div className="border border-slate-600 rounded-lg">
      {/* Header for Title */}
      <header className="p-4 border-b border-slate-600">
        <h2 className="text-xl font-bold text-slate-100">{sheetData.title}</h2>
      </header>
      
      <div className="divide-y divide-slate-600">
        {sheetData.sections.map(section => (
          <section key={section.id} id={section.id} className="grid grid-cols-1 md:grid-cols-3 scroll-mt-20">
            {/* Cues Column */}
            <div className="p-4 border-b md:border-b-0 md:border-r border-slate-600">
              <h3 className="text-lg font-semibold text-cyan-400 sticky top-4">
                {section.title}
              </h3>
            </div>
            {/* Notes Column */}
            <div className="md:col-span-2 p-4">
              <div
                className="prose prose-invert prose-slate max-w-none prose-p:text-slate-300 prose-li:text-slate-300 prose-a:text-cyan-400 prose-strong:text-slate-100"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(section.content) }}
              />
            </div>
          </section>
        ))}
      </div>
      
      {/* Summary Footer */}
      <footer className="p-4 border-t border-slate-600 bg-slate-900/50 rounded-b-lg">
        <h3 className="text-lg font-semibold text-slate-200 mb-2">Summary</h3>
        <p className="text-slate-400 text-sm">
          This revision sheet covers the key topics from "{sheetData.title}". Use the cues on the left to test your recall of the notes on the right.
        </p>
      </footer>
    </div>
  );
};
