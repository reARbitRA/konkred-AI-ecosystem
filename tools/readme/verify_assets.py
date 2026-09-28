#!/usr/bin/env python3
"""Strict checks for generated README assets and README references."""
from pathlib import Path
import re, sys, xml.etree.ElementTree as ET
root=Path(__file__).resolve().parents[2]; asset=root/'assets/readme'; expected=['hero.svg','provider-rack.svg','gateway-core.svg','routing-engine.svg','quota-ledger.svg','fallback-sequence.svg','cache-dedup.svg','request-lifecycle.svg','telegram-runtime.svg','redis-memory.svg','api-console.svg','health-console.svg','verification-console.svg','docker-topology.svg','deployment-map.svg','footer.svg']
errors=[]
for name in expected:
 p=asset/name
 if not p.exists(): errors.append(f'missing {name}'); continue
 try:
  text=p.read_text(); ET.fromstring(text)
  if '<script' in text.lower() or 'javascript:' in text.lower(): errors.append(f'{name}: script content is not Camo-safe')
  if 'prefers-reduced-motion' not in text: errors.append(f'{name}: missing reduced-motion rule')
 except Exception as e: errors.append(f'{name}: invalid SVG: {e}')
readme=(root/'README.md').read_text()
for name in expected:
 if f'assets/readme/{name}' not in readme: errors.append(f'README does not reference {name}')
if errors:
 print('\n'.join('FAIL '+e for e in errors)); sys.exit(1)
print(f'PASS {len(expected)} README SVG assets: XML, Camo-safe, reduced-motion, README-linked')
