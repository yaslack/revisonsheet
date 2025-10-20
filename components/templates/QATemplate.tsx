// Fix: Implement the QATemplate component.
import React from 'react';
import { RevisionSheetData } from '../../types';
import { renderMarkdown } from '../../utils/markdownRenderer';
import { HelpCircleIcon } from '../icons/HelpCircleIcon';

interface TemplateProps {
  sheetData: RevisionSheetData;
}

export const QATemplate: React.FC<TemplateProps> = ({ sheetData }) => {
  return (
    <div className="space-y-6">
      {sheetData.sections.map((section) => (
        <details key={section.id} id={section.id} className="group bg-slate-800 rounded-lg border border-slate-700 open:border-cyan-500/50 transition-colors duration-300 scroll-mt-20" open>
          <summary className="flex items-center gap-3 p-4 cursor-pointer list-none">
            <HelpCircleIcon className="w-6 h-6 text-cyan-400 flex-shrink-0" />
            <h3 className="text-lg font-semibold text-slate-100 group-hover:text-cyan-300 transition-colors">
              {section.title}
            </h3>
            <div className="ml-auto transform transition-transform duration-300 group-open:rotate-90">
                <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                </svg>
            </div>
          </summary>
          <div className="p-4 pt-0 border-t border-slate-700">
            <div
              className="prose prose-invert prose-slate max-w-none prose-p:text-slate-300 prose-li:text-slate-300 prose-a:text-cyan-400 prose-strong:text-slate-100"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(section.content) }}
            />
          </div>
        </details>
      ))}
    </div>
  );
};
