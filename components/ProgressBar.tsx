
import React from 'react';

interface ProgressBarProps {
  step: string;
  percentage: number;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ step, percentage }) => {
  return (
    <div className="w-full bg-slate-700/50 rounded-lg p-4">
      <div className="flex justify-between items-center mb-2">
        <p className="text-sm font-medium text-slate-300">{step}</p>
        <p className="text-sm font-semibold text-cyan-400">{percentage}%</p>
      </div>
      <div className="w-full bg-slate-600 rounded-full h-2.5">
        <div 
          className="bg-gradient-to-r from-sky-500 to-cyan-400 h-2.5 rounded-full transition-all duration-500 ease-out" 
          style={{ width: `${percentage}%` }}
        ></div>
      </div>
    </div>
  );
};

export default ProgressBar;
