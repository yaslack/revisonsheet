import React from 'react';
import { Section } from '../types';

interface TableOfContentsProps {
  sections: Section[];
  activeId: string | null;
}

const TableOfContents: React.FC<TableOfContentsProps> = ({ sections, activeId }) => {
  const scrollTo = (id: string) => {
    const element = document.getElementById(id);
    const contentArea = document.getElementById('revision-sheet-content');
    if (element && contentArea) {
      const offsetTop = element.offsetTop - contentArea.offsetTop;
      contentArea.scrollTo({ top: offsetTop, behavior: 'smooth' });
    }
  };

  return (
    <div className="bg-slate-800/60 p-4 rounded-lg border border-slate-700">
      <h3 className="font-bold text-lg mb-3 text-slate-200">Contents</h3>
      <nav>
        <ul className="space-y-2">
          {sections.map(section => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollTo(section.id);
                }}
                className={`block text-sm transition-all duration-200 ease-in-out pl-3 border-l-2
                  ${activeId === section.id
                    ? 'text-cyan-400 font-semibold border-cyan-400'
                    : 'text-slate-400 hover:text-slate-200 border-slate-600 hover:border-slate-400'
                  }`}
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
};

export default TableOfContents;
