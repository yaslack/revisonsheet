import React, { useState, useMemo } from 'react';
import { RevisionSheetData, Template } from '../types';
import { useScrollSpy } from '../hooks/useScrollSpy';
import { generateTextPdf } from '../utils/pdfGenerator';

import TableOfContents from './TableOfContents';
import TemplateSwitcher from './TemplateSwitcher';
import { StandardTemplate } from './templates/StandardTemplate';
import { CornellTemplate } from './templates/CornellTemplate';
import { MindMapTemplate } from './templates/MindMapTemplate';
import { QATemplate } from './templates/QATemplate';

import { RefreshIcon } from './icons/RefreshIcon';
import { SparklesIcon } from './icons/SparklesIcon';
import { SpinnerIcon } from './icons/SpinnerIcon';
import { DownloadIcon } from './icons/DownloadIcon';

interface RevisionSheetProps {
  sheetData: RevisionSheetData;
  onReset?: () => void;
  onRefine?: () => void;
  isRefining?: boolean;
  resetLabel?: string;
  disableRefine?: boolean;
}

const RevisionSheet: React.FC<RevisionSheetProps> = ({
  sheetData,
  onReset,
  onRefine,
  isRefining = false,
  resetLabel = 'Start Over',
  disableRefine = false
}) => {
  const [template, setTemplate] = useState<Template>('standard');
  const sectionIds = useMemo(() => sheetData.sections.map(s => s.id), [sheetData.sections]);
  const activeId = useScrollSpy(sectionIds, { rootMargin: '-20% 0% -70% 0%' });

  const renderTemplate = () => {
    switch (template) {
      case 'cornell':
        return <CornellTemplate sheetData={sheetData} />;
      case 'mindmap':
        return <MindMapTemplate sheetData={sheetData} />;
      case 'qa':
        return <QATemplate sheetData={sheetData} />;
      case 'standard':
      default:
        return <StandardTemplate sheetData={sheetData} />;
    }
  };

  const handleDownloadPdf = async () => {
    try {
      await generateTextPdf(sheetData);
    } catch (error) {
      console.error('Failed to generate PDF:', error);
      alert('There was an error generating the PDF. Please check the console for details.');
    }
  };

  return (
    <div className="animate-fade-in-fast">
      <header className="mb-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <h2 className="text-3xl font-bold bg-gradient-to-r from-sky-300 to-cyan-300 text-transparent bg-clip-text flex-1">
            {sheetData.title}
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
             <TemplateSwitcher currentTemplate={template} onTemplateChange={setTemplate} />
             <button
                onClick={handleDownloadPdf}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors"
                aria-label="Download as PDF"
             >
                <DownloadIcon className="w-4 h-4"/>
                <span>PDF</span>
             </button>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <aside className="lg:col-span-1 lg:sticky lg:top-8 self-start hidden lg:block">
          <TableOfContents sections={sheetData.sections} activeId={activeId} />
        </aside>

        <div id="revision-sheet-content" className="lg:col-span-3 bg-slate-900/50 p-6 sm:p-8 rounded-lg border border-slate-700 max-h-[70vh] overflow-y-auto relative">
          {renderTemplate()}
        </div>
      </div>
      
      {(onRefine || onReset) && (
        <footer className="mt-8 flex flex-col sm:flex-row justify-center items-center gap-4">
          {onRefine && !disableRefine && (
            <button
              onClick={onRefine}
              disabled={isRefining}
              className="w-full sm:w-auto flex items-center justify-center gap-2 bg-sky-500 hover:bg-sky-600 disabled:bg-slate-600 text-white font-bold py-3 px-6 rounded-lg transition-transform transform hover:scale-105 duration-200 ease-in-out shadow-lg shadow-sky-500/20"
            >
              {isRefining ? (
                <>
                  <SpinnerIcon className="w-5 h-5" />
                  <span>Refining...</span>
                </>
              ) : (
                <>
                  <SparklesIcon className="w-5 h-5" />
                  <span>Refine Sheet</span>
                </>
              )}
            </button>
          )}
          {onReset && (
            <button
              onClick={onReset}
              className="w-full sm:w-auto flex items-center justify-center gap-2 bg-slate-600 hover:bg-slate-700 text-slate-300 font-bold py-3 px-6 rounded-lg transition-colors"
            >
              <RefreshIcon className="w-5 h-5" />
              <span>{resetLabel}</span>
            </button>
          )}
        </footer>
      )}
    </div>
  );
};

export default RevisionSheet;
