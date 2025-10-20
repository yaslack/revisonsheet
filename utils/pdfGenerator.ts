import jsPDF from 'jspdf';
import { RevisionSheetData } from '../types';

const PAGE_MARGIN = 20;
const FONT_SIZES = {
    title: 22,
    h1: 18,
    h2: 16,
    body: 12,
    code: 10,
};
const LINE_HEIGHT = 1.5;

class PdfBuilder {
    doc: jsPDF;
    cursorY: number;
    pageWidth: number;
    pageHeight: number;
    contentWidth: number;

    constructor() {
        this.doc = new jsPDF();
        this.cursorY = PAGE_MARGIN;
        const pageInfo = this.doc.internal.pageSize;
        this.pageWidth = pageInfo.getWidth();
        this.pageHeight = pageInfo.getHeight();
        this.contentWidth = this.pageWidth - PAGE_MARGIN * 2;
    }

    checkPageBreak(heightNeeded: number) {
        if (this.cursorY + heightNeeded > this.pageHeight - PAGE_MARGIN) {
            this.doc.addPage();
            this.cursorY = PAGE_MARGIN;
        }
    }

    addTitle(text: string) {
        this.doc.setFont('helvetica', 'bold');
        this.doc.setFontSize(FONT_SIZES.title);
        const lines = this.doc.splitTextToSize(text, this.contentWidth);
        this.checkPageBreak(lines.length * FONT_SIZES.title / 2);
        this.doc.text(lines, this.pageWidth / 2, this.cursorY, { align: 'center' });
        this.cursorY += (lines.length * FONT_SIZES.title / 2) + 10;
    }

    addSectionTitle(text: string) {
        this.checkPageBreak(FONT_SIZES.h1 + 5);
        this.doc.setFont('helvetica', 'bold');
        this.doc.setFontSize(FONT_SIZES.h1);
        this.doc.text(text, PAGE_MARGIN, this.cursorY);
        this.cursorY += FONT_SIZES.h1;
        this.doc.setLineWidth(0.5);
        this.doc.line(PAGE_MARGIN, this.cursorY, this.pageWidth - PAGE_MARGIN, this.cursorY);
        this.cursorY += 5;
    }
    
    renderContent(content: string) {
        // Regex to split content by custom tags and regular text
        const parts = content.split(/(!def\[[\s\S]*?\]|!imp\[[\s\S]*?\]|!formula\[[\s\S]*?\])/g).filter(Boolean);
        
        parts.forEach(part => {
            if (part.startsWith('!def[')) {
                const text = part.slice(5, -1);
                this.addHighlightBox(text, 'Definition', [230, 247, 255], [59, 130, 246]); // Light blue, blue
            } else if (part.startsWith('!imp[')) {
                const text = part.slice(5, -1);
                this.addHighlightBox(text, 'Important', [255, 251, 235], [245, 158, 11]); // Light yellow, amber
            } else if (part.startsWith('!formula[')) {
                const text = part.slice(9, -1);
                this.addFormulaBox(text);
            } else {
                this.addBodyText(part);
            }
        });
    }

    addHighlightBox(text: string, title: string, bgColor: [number, number, number], borderColor: [number, number, number]) {
        this.doc.setFont('helvetica', 'normal');
        this.doc.setFontSize(FONT_SIZES.body);
        const lines = this.doc.splitTextToSize(text, this.contentWidth - 12);
        const boxHeight = (lines.length * FONT_SIZES.body / 2.5 * LINE_HEIGHT) + 10;
        
        this.checkPageBreak(boxHeight + 5);
        
        this.doc.setDrawColor(...borderColor);
        this.doc.setFillColor(...bgColor);
        this.doc.rect(PAGE_MARGIN, this.cursorY, this.contentWidth, boxHeight, 'FD');
        this.doc.setLineWidth(1);
        this.doc.line(PAGE_MARGIN, this.cursorY, PAGE_MARGIN, this.cursorY + boxHeight);

        this.doc.setFont('helvetica', 'bold');
        this.doc.setTextColor(...borderColor);
        this.doc.text(`${title}:`, PAGE_MARGIN + 3, this.cursorY + 8);
        this.doc.setTextColor(0, 0, 0);

        const titleWidth = this.doc.getStringUnitWidth(`${title}:`) * FONT_SIZES.body / this.doc.internal.scaleFactor;
        
        this.doc.setFont('helvetica', 'normal');
        this.doc.text(text, PAGE_MARGIN + 3, this.cursorY + 8);
        
        this.cursorY += boxHeight + 5;
    }

    addFormulaBox(text: string) {
        this.doc.setFont('courier', 'normal');
        this.doc.setFontSize(FONT_SIZES.code);
        const lines = this.doc.splitTextToSize(text, this.contentWidth - 6);
        const boxHeight = (lines.length * FONT_SIZES.code / 2.5 * LINE_HEIGHT) + 10;
        
        this.checkPageBreak(boxHeight + 5);
        
        this.doc.setFillColor(248, 249, 250); // Light gray
        this.doc.rect(PAGE_MARGIN, this.cursorY, this.contentWidth, boxHeight, 'F');
        this.doc.setTextColor(0, 0, 0);
        this.doc.text(lines, PAGE_MARGIN + 3, this.cursorY + 8);

        this.cursorY += boxHeight + 5;
    }

    addBodyText(text: string) {
        const lines = text.split('\n');
        lines.forEach(line => {
             // Handle lists
            const isListItem = line.trim().startsWith('* ') || line.trim().startsWith('- ');
            const content = isListItem ? line.trim().substring(2) : line;
            const indent = isListItem ? 5 : 0;
            
            // Handle bold text
            const parts = content.split(/(\*\*.*?\*\*)/g).filter(Boolean);

            let currentX = PAGE_MARGIN + indent;
            let splitText = this.doc.splitTextToSize(content, this.contentWidth - indent);
            this.checkPageBreak(splitText.length * FONT_SIZES.body / 2.5 * LINE_HEIGHT);

            if (isListItem) {
                 this.doc.circle(PAGE_MARGIN + 2, this.cursorY + 1.5, 1, 'F');
            }

            // A bit complex to handle bold inline, simpler version for now
            this.doc.setFont('helvetica', 'normal');
            this.doc.setFontSize(FONT_SIZES.body);
            this.doc.text(splitText, currentX, this.cursorY);
            this.cursorY += (splitText.length * FONT_SIZES.body / 2.5 * LINE_HEIGHT);
        });
    }

    save(filename: string) {
        this.doc.save(filename);
    }
}

export const generateTextPdf = async (sheetData: RevisionSheetData): Promise<void> => {
    const builder = new PdfBuilder();

    builder.addTitle(sheetData.title);

    sheetData.sections.forEach(section => {
        builder.addSectionTitle(section.title);
        builder.renderContent(section.content);
        builder.cursorY += 5; // spacing between sections
    });
    
    const safeFilename = `${sheetData.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_sheet.pdf`;
    builder.save(safeFilename);
};
