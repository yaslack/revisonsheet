import React, { useEffect, useState } from 'react';
import { GenerationSettings } from '../types';
import { SettingsIcon } from './icons/SettingsIcon';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: GenerationSettings;
    onSettingsChange: React.Dispatch<React.SetStateAction<GenerationSettings>>;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, settings, onSettingsChange }) => {
    if (!isOpen) return null;

    const handleModelChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const value = e.target.value;
        onSettingsChange(prev => ({
            ...prev,
            model: value
        }));
    };

    const handleBaseUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        onSettingsChange(prev => ({
            ...prev,
            baseUrl: value
        }));
    };

    const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        onSettingsChange(prev => ({
            ...prev,
            apiKey: value
        }));
    };

    const [models, setModels] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState('');

    const loadModels = async () => {
        const baseUrl = settings.baseUrl?.replace(/\/$/, '');
        if (!baseUrl) return;
        setLoading(true);
        setLoadError('');
        try {
            const res = await fetch(`${baseUrl}/models`);
            if (!res.ok) {
                throw new Error(`${res.status} ${res.statusText}`);
            }
            const data = await res.json();
            const list: string[] = Array.isArray(data?.data)
                ? data.data.map((m: any) => m?.id).filter(Boolean)
                : Array.isArray(data)
                    ? data.map((m: any) => m?.id || m).filter(Boolean)
                    : [];
            setModels(list);
            if (list.length > 0 && !(settings.model && settings.model.trim())) {
                const firstModel = String(list[0]);
                onSettingsChange(prev => ({
                    ...prev,
                    model: firstModel
                }));
            }
        } catch (err: any) {
            setLoadError(`Failed to load models: ${err.message || err}`);
            setModels([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen && settings.baseUrl) {
            loadModels();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, settings.baseUrl]);

    return (
        <div 
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in-fast"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
        >
            <div 
                className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-full max-w-md p-6 m-4 animate-slide-up-fast"
                onClick={(e) => e.stopPropagation()}
                role="document"
            >
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <SettingsIcon className="w-6 h-6 text-sky-400"/>
                        <h2 id="settings-title" className="text-xl font-bold text-slate-100">Settings</h2>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none" aria-label="Close settings">&times;</button>
                </div>
                
                <div className="space-y-4">
                    <div>
                        <label htmlFor="base-url" className="block text-sm font-medium text-slate-300 mb-2">
                            LM Studio Base URL
                        </label>
                        <input
                            id="base-url"
                            type="text"
                            placeholder="http://localhost:1234/v1"
                            value={settings.baseUrl ?? ''}
                            onChange={handleBaseUrlChange}
                            className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
                        />
                        <div className="flex items-center justify-between mt-1">
                            <p className="text-xs text-slate-500">Default LM Studio endpoint is http://localhost:1234/v1</p>
                            <button
                                type="button"
                                onClick={loadModels}
                                className="text-xs text-sky-400 hover:text-sky-300"
                                aria-label="Reload models"
                            >{loading ? 'Loading…' : 'Reload models'}</button>
                        </div>
                        {loadError && <p className="text-xs text-red-400 mt-1">{loadError}</p>}
                    </div>
                    {models.length > 0 ? (
                        <div>
                            <label htmlFor="model-select" className="block text-sm font-medium text-slate-300 mb-2">
                                Model
                            </label>
                            <select
                                id="model-select"
                                value={settings.model}
                                onChange={handleModelChange}
                                className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
                            >
                                <option value="">(Use currently loaded model)</option>
                                {models.map(m => (
                                    <option key={m} value={m}>{m}</option>
                                ))}
                            </select>
                            <p className="text-xs text-slate-500 mt-1">Choose a model reported by LM Studio.</p>
                        </div>
                    ) : (
                        <div>
                            <label htmlFor="model-input" className="block text-sm font-medium text-slate-300 mb-2">
                                Model Name
                            </label>
                            <input
                                id="model-input"
                                type="text"
                                placeholder="e.g. Llama-3.1-8B-Instruct"
                                value={settings.model}
                                onChange={handleModelChange}
                                className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
                            />
                            <p className="text-xs text-slate-500 mt-1">Enter the exact model name loaded in LM Studio.</p>
                        </div>
                    )}
                    <div>
                        <label htmlFor="api-key" className="block text-sm font-medium text-slate-300 mb-2">
                            API Key (optional)
                        </label>
                        <input
                            id="api-key"
                            type="password"
                            value={settings.apiKey ?? ''}
                            onChange={handleApiKeyChange}
                            className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-slate-200 focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
                            placeholder="Leave blank if not required"
                        />
                        <p className="text-xs text-slate-500 mt-1">LM Studio usually doesn’t require a key.</p>
                    </div>
                </div>

                <div className="mt-6 flex justify-end">
                    <button
                        onClick={onClose}
                        className="bg-sky-500 hover:bg-sky-600 text-white font-bold py-2 px-4 rounded-md transition-colors"
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
