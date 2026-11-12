"""Build the English project report with the proposal's A4 academic layout.

Requires ReportLab. Run from any directory; all document inputs are repository-relative.
"""
from pathlib import Path
import json
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted,
    Image, Table, TableStyle, KeepTogether,
)

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/project-report-source.json'
OUTPUT = ROOT / 'docs/COMP5411_Project_Report.pdf'
WIDTH = A4[0] - 40 * mm
styles = getSampleStyleSheet()
styles.add(ParagraphStyle('ReportBody', fontName='Times-Roman', fontSize=10.3,
                          leading=13.2, spaceAfter=6, alignment=TA_JUSTIFY))
styles.add(ParagraphStyle('ReportHeading', fontName='Times-Bold', fontSize=14,
                          leading=17, spaceBefore=9, spaceAfter=8, keepWithNext=True))
styles.add(ParagraphStyle('ReportSubheading', fontName='Times-Bold', fontSize=11,
                          leading=14, spaceBefore=6, spaceAfter=5, keepWithNext=True))
styles.add(ParagraphStyle('ReportCaption', fontName='Times-Roman', fontSize=9,
                          leading=11, spaceBefore=4, spaceAfter=8))
styles.add(ParagraphStyle('ReportCell', fontName='Times-Roman', fontSize=8.8,
                          leading=11))
styles.add(ParagraphStyle('ReportCode', fontName='Courier', fontSize=8.2,
                          leading=10.4, spaceBefore=3, spaceAfter=8,
                          leftIndent=8, borderPadding=6, backColor=colors.HexColor('#f3f3f3')))
styles.add(ParagraphStyle('ReportTitle', fontName='Times-Bold', fontSize=18,
                          leading=22, alignment=TA_CENTER, spaceAfter=8))
styles.add(ParagraphStyle('ReportSubtitle', fontName='Times-Roman', fontSize=14,
                          leading=18, alignment=TA_CENTER, spaceAfter=18))
styles.add(ParagraphStyle('ReportAuthors', fontName='Times-Roman', fontSize=11,
                          leading=15, alignment=TA_CENTER, spaceAfter=12))


def page_frame(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.black)
    if doc.page > 1:
        canvas.setFont('Times-Roman', 9)
        canvas.drawString(20 * mm, A4[1] - 15 * mm, 'Project Report')
        canvas.setFont('Times-Bold', 9)
        canvas.drawString(20 * mm, A4[1] - 19 * mm, 'Noto Peninsula: An Interactive 3D Landscape')
        canvas.setFont('Times-Roman', 9)
        canvas.drawRightString(A4[0] - 20 * mm, A4[1] - 15 * mm, 'Group 12')
        canvas.drawRightString(A4[0] - 20 * mm, A4[1] - 19 * mm, 'LEE Hyunjin, TAN Jiming')
        canvas.setLineWidth(0.4)
        canvas.line(20 * mm, A4[1] - 22 * mm, A4[0] - 20 * mm, A4[1] - 22 * mm)
    canvas.setFont('Times-Roman', 10)
    canvas.drawCentredString(A4[0] / 2, 15 * mm, str(doc.page))
    canvas.restoreState()


def make_table(block):
    widths = [WIDTH * v / sum(block['widths']) for v in block['widths']]
    rows = []
    for row_index, row in enumerate(block['rows']):
        cells = []
        for cell in row:
            text = escape(str(cell)).replace('&lt;br/&gt;', '<br/>')
            cells.append(Paragraph(f'<b>{text}</b>' if row_index == 0 else text,
                                   styles['ReportCell']))
        rows.append(cells)
    table = Table(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
    table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eaeaea')),
        ('LINEABOVE', (0, 0), (-1, 0), 0.7, colors.black),
        ('LINEBELOW', (0, 0), (-1, 0), 0.4, colors.black),
        ('LINEBELOW', (0, -1), (-1, -1), 0.7, colors.black),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f7f7f7')]),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
    ]))
    return table


def main():
    content = json.loads(SOURCE.read_text(encoding='utf-8'))
    story = []
    for block in content['blocks']:
        kind = block['type']
        if kind == 'title':
            story.extend([
                Spacer(1, 12 * mm),
                Paragraph(content['title'], styles['ReportTitle']),
                Paragraph('Project Report', styles['ReportSubtitle']),
                Paragraph('Group 12<br/>LEE Hyunjin, TAN Jiming', styles['ReportAuthors']),
                Paragraph('HKUST - COMP5411 - Fall 2026<br/>12 November 2026', styles['ReportAuthors']),
                Spacer(1, 4 * mm),
            ])
        elif kind == 'page':
            story.append(PageBreak())
        elif kind in ('p', 'h', 'sub', 'caption'):
            style = {'p': 'ReportBody', 'h': 'ReportHeading',
                     'sub': 'ReportSubheading', 'caption': 'ReportCaption'}[kind]
            story.append(Paragraph(block['text'], styles[style]))
        elif kind == 'code':
            story.append(Preformatted(block['text'], styles['ReportCode']))
        elif kind == 'table':
            story.extend([make_table(block), Spacer(1, 7)])
        elif kind == 'figure':
            picture = Image(str(ROOT / block['path']))
            width = WIDTH * block.get('fraction', 1)
            height = width * picture.imageHeight / picture.imageWidth
            picture.drawWidth, picture.drawHeight = width, height
            story.append(KeepTogether([picture,
                Paragraph(block['caption'], styles['ReportCaption'])]))
        elif kind == 'performance':
            evidence = json.loads((ROOT / block['path']).read_text(encoding='utf-8'))
            for item in evidence['report_blocks']:
                if item['type'] == 'table':
                    story.extend([make_table(item), Spacer(1, 7)])
                else:
                    story.append(Paragraph(item['text'], styles['ReportBody']))
        else:
            raise ValueError(f'Unknown report block: {kind}')
    document = SimpleDocTemplate(str(OUTPUT), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=30 * mm, bottomMargin=30 * mm,
        title=content['title'] + ' - Project Report', author='LEE Hyunjin; TAN Jiming')
    document.build(story, onFirstPage=page_frame, onLaterPages=page_frame)
    print(OUTPUT)


if __name__ == '__main__':
    main()
