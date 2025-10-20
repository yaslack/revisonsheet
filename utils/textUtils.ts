export const chunkText = (text: string, size: number): string[] => {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.substring(i, i + size));
    }
    return chunks;
};

export const normalizeText = (text: string): string => {
    if (!text) return text;
    const unifiedNewlines = text.replace(/\r\n?/g, '\n');
    const collapsedWhitespace = unifiedNewlines.replace(/[ \t]+/g, ' ');
    const trimmedTrailingSpaces = collapsedWhitespace.replace(/ +\n/g, '\n');
    const compactBlankLines = trimmedTrailingSpaces.replace(/\n{3,}/g, '\n\n');
    return compactBlankLines.trim();
};

export const trimForContext = (text: string, maxLength: number): string => {
    if (text.length <= maxLength) {
        return text;
    }
    if (maxLength <= 0) {
        return '';
    }
    const prefixLength = Math.max(0, Math.floor(maxLength * 0.6));
    const suffixLength = Math.max(0, maxLength - prefixLength - 10);
    const prefix = text.slice(0, prefixLength);
    const suffix = suffixLength > 0 ? text.slice(-suffixLength) : '';
    return `${prefix}\n...\n${suffix}`;
};
