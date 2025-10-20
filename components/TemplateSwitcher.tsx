import React from 'react';
import { Template } from '../types';
import { LayoutGridIcon } from './icons/LayoutGridIcon';
import { ColumnsIcon } from './icons/ColumnsIcon';
import { GitBranchIcon } from './icons/GitBranchIcon';
import { HelpCircleIcon } from './icons/HelpCircleIcon';

interface TemplateSwitcherProps {
  currentTemplate: Template;
  onTemplateChange: (template: Template) => void;
}

const templates: { id: Template; name: string; icon: React.FC<React.SVGProps<SVGSVGElement>> }[] = [
  { id: 'standard', name: 'Standard', icon: LayoutGridIcon },
  { id: 'cornell', name: 'Cornell', icon: ColumnsIcon },
  { id: 'mindmap', name: 'Mind Map', icon: GitBranchIcon },
  { id: 'qa', name: 'Q & A', icon: HelpCircleIcon },
];

const TemplateSwitcher: React.FC<TemplateSwitcherProps> = ({ currentTemplate, onTemplateChange }) => {
  return (
    <div className="bg-slate-800/60 p-2 rounded-lg border border-slate-700 flex items-center gap-2">
      <p className="text-sm font-semibold text-slate-300 mr-2">View:</p>
      {templates.map(({ id, name, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onTemplateChange(id)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${
            currentTemplate === id
              ? 'bg-cyan-500 text-white font-semibold shadow-md'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
          aria-label={`Switch to ${name} view`}
        >
          <Icon className="w-4 h-4" />
          {name}
        </button>
      ))}
    </div>
  );
};

export default TemplateSwitcher;
