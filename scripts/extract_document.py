#!/usr/bin/env python3
"""Bounded text extraction only. Never execute content in submitted documents."""
import sys, json, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

path=Path(sys.argv[1]); kind=sys.argv[2]
result={'text':'','warnings':[]}
if kind=='pdf':
    from pypdf import PdfReader
    reader=PdfReader(path)
    if reader.is_encrypted: raise ValueError('Encrypted PDF is not supported')
    if len(reader.pages)>300: raise ValueError('PDF exceeds 300 pages')
    parts=[]
    for i,page in enumerate(reader.pages):
        value=(page.extract_text() or '')[:30000]
        parts.append('[Page %s]\n%s'%(i+1,value))
        if sum(map(len,parts))>500000: raise ValueError('Extracted text exceeds limit')
    result['text']='\n\n'.join(parts)
    result['pages']=len(reader.pages)
    if not any((p.extract_text() or '').strip() for p in reader.pages[:3]): result['warnings'].append('Scanned or empty PDF: upload a text version; OCR was not performed.')
elif kind=='docx':
    with zipfile.ZipFile(path) as z:
        info=z.getinfo('word/document.xml')
        if info.file_size>10*1024*1024: raise ValueError('DOCX text XML exceeds limit')
        xml=z.read(info)
        if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml: raise ValueError('XML entities are not supported')
        root=ET.fromstring(xml)
        ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        result['text']='\n'.join(''.join(p.itertext()) for p in root.findall('.//w:p',ns))[:500000]
else: raise ValueError('Unsupported extraction format')
print(json.dumps(result,ensure_ascii=False))
