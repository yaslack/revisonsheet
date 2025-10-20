// Fix: Implement the MindMapTemplate component.
import React from 'react';
import { RevisionSheetData } from '../../types';
import { GitBranchIcon } from '../icons/GitBranchIcon';

interface TemplateProps {
    sheetData: RevisionSheetData;
}

const Node: React.FC<{ text: string; level: number; id?: string }> = ({ text, level, id }) => {
    const paddingLeft = `${level * 1.5}rem`;
    const fontSize = level === 0 ? 'text-2xl' : level === 1 ? 'text-xl' : 'text-base';
    const textColor = level === 0 ? 'text-cyan-300' : level === 1 ? 'text-slate-100' : 'text-slate-300';
    const fontWeight = level < 2 ? 'font-bold' : 'font-normal';
    
    return (
        <li id={id} className="flex items-center gap-2 scroll-mt-20" style={{ paddingLeft }}>
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${level === 0 ? 'bg-cyan-400' : 'bg-slate-500'}`}></div>
            <span className={`${fontSize} ${textColor} ${fontWeight}`}>{text}</span>
        </li>
    );
};

const parseContentForNodes = (content: string): string[] => {
    // A simple heuristic to get some items for the mind map
    const nodes: Set<string> = new Set();
    const lines = content.split('\n');
    for (const line of lines) {
        if (line.startsWith('### ')) {
            nodes.add(line.substring(4).trim());
        } else if (line.startsWith('**') && line.includes('**', 2)) {
            const match = line.match(/\*\*(.*?)\*\*/);
            if(match && match[1]) nodes.add(match[1].trim());
        } else if (line.trim().startsWith('* ') || line.trim().startsWith('- ')) {
            nodes.add(line.trim().substring(2).trim());
        }
    }
    return Array.from(nodes).filter(n => n).slice(0, 4); // Get unique, non-empty, and limit
};

export const MindMapTemplate: React.FC<TemplateProps> = ({ sheetData }) => {
    return (
        <div className="space-y-4 p-4">
            <div className="flex items-center gap-3 mb-4">
                <GitBranchIcon className="w-8 h-8 text-cyan-400" />
                <h2 className="text-3xl font-bold text-slate-100">Mind Map View</h2>
            </div>
            <ul className="space-y-3">
                <Node text={sheetData.title} level={0} />
                {sheetData.sections.map(section => (
                    <React.Fragment key={section.id}>
                        <Node text={section.title} level={1} id={section.id} />
                        {parseContentForNodes(section.content).map((subNode, index) => (
                             <Node key={`${section.id}-${index}`} text={subNode} level={2} />
                        ))}
                    </React.Fragment>
                ))}
            </ul>
        </div>
    );
};
