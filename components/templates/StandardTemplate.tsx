// Fix: Implement the StandardTemplate component.
import React from 'react';
import { RevisionSheetData } from '../../types';
import { renderMarkdown } from '../../utils/markdownRenderer';

interface TemplateProps {
  sheetData: RevisionSheetData;
}

export const StandardTemplate: React.FC<TemplateProps> = ({ sheetData }) => {
  return (
    <div className="space-y-8">
      {sheetData.sections.map(section => (
        <section key={section.id} id={section.id} className="scroll-mt-20">
          <h3 className="text-2xl font-bold text-slate-100 border-b-2 border-slate-600 pb-2 mb-4">
            {section.title}
          </h3>
          <div
            className="prose prose-invert prose-slate max-w-none prose-h4:text-lg prose-h4:font-semibold prose-h4:text-slate-300 prose-p:text-slate-300 prose-li:text-slate-300 prose-a:text-cyan-400 prose-strong:text-slate-100"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(section.content) }}
          />
        </section>
      ))}
    </div>
  );
};
