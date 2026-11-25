T = []
def t(**k): T.append(k)

D = dict(contentBg=None, inputBg='#ffffff', hrule='', htitle=None, r=0, bw=1, case='none', base=16,
         item='side', results='list', mono='', shadow='', hw=700, site='Dickinson Historical Society',
         idno='DS5C740001', pageImg='', navUpper=False, skip=False, fborder='')

t(n=1, stem='Main', name='Reading Room', fonts='Roboto:wght@500;700&family=Open+Sans:wght@400;600',
  hf="Roboto, sans-serif", bf="'Open Sans', sans-serif", pageBg='#e5e9ef', surface='#ffffff', ink='#111111',
  text='#3a3a3a', muted='#4a5056', accent='#f0792d', onAccent='#1a1a1a', hi='#8a4310', link='#1d4f73',
  border='#d7dce2', ib='#8b939c', hdr='bar', hbg='#3c3c3c', htx='#ffffff', fbg='#3c3c3c', ftx='#c9cdd1',
  phbg='#c9d0d8', phtx='#3c434b', r=6)
t(n=2, stem='T02-Broadsheet', name='Broadsheet', fonts='Playfair+Display:wght@700;900&family=Source+Serif+4:wght@400;600',
  hf="'Playfair Display', serif", bf="'Source Serif 4', serif", pageBg='#ffffff', surface='#ffffff', ink='#111111',
  text='#1c1c1c', muted='#4a4a4a', accent='#111111', onAccent='#ffffff', hi='#7a1f1f', link='#111111',
  border='#1c1c1c', ib='#1c1c1c', hdr='centered', hbg='#ffffff', htx='#111111', fbg='#ffffff', ftx='#4a4a4a',
  fborder='3px double #1c1c1c', phbg='#d9d9d9', phtx='#333333', item='stack')
t(n=3, stem='T03-CardCatalog', name='Card Catalog', fonts='Courier+Prime:wght@400;700&family=Zilla+Slab:wght@500;700',
  hf="'Zilla Slab', serif", bf="'Courier Prime', monospace", pageBg='#5b4632', contentBg='#f4ead2', surface='#fffaf0',
  ink='#2b2118', text='#2b2118', muted='#5a4632', accent='#2b2118', onAccent='#f4ead2', hi='#b23a2e', link='#5a2a0c',
  border='#2b2118', ib='#2b2118', inputBg='#fffaf0', hdr='plain', hbg='#5b4632', htx='#f4ead2', fbg='#5b4632',
  ftx='#f4ead2', phbg='#d8ccb0', phtx='#2b2118', r=4, mono="'Courier Prime', monospace")
t(n=4, stem='T04-GalleryWall', name='Gallery Wall', fonts='Inter:wght@400;500;700',
  hf="Inter, sans-serif", bf="Inter, sans-serif", pageBg='#141414', surface='#1f1f1f', ink='#ffffff', text='#e8e8e8',
  muted='#c4c4c4', accent='#ffffff', onAccent='#141414', hi='#c4c4c4', link='#ffffff', border='#4a4a4a', ib='#8a8a8a',
  inputBg='#1f1f1f', hdr='plain', hbg='#141414', htx='#ffffff', fbg='#141414', ftx='#c4c4c4', fborder='1px solid #4a4a4a',
  phbg='#3a3a3a', phtx='#d0d0d0', item='stack', results='grid')
t(n=5, stem='T05-Bayou', name='Bayou', fonts='Fraunces:wght@500;700&family=Public+Sans:wght@400;600',
  hf="Fraunces, serif", bf="'Public Sans', sans-serif", pageBg='#eef3ee', surface='#ffffff', ink='#12403a', text='#24332f',
  muted='#44574f', accent='#e6c15a', onAccent='#1d2a12', hi='#0f4f47', link='#0f4f47', border='#c3d4cc', ib='#6f857c',
  hdr='bar', hbg='#12403a', htx='#ffffff', fbg='#12403a', ftx='#dcebe6', phbg='#c3d4cc', phtx='#24332f', r=8)
t(n=6, stem='T06-SwissGrid', name='Swiss Grid', fonts='Archivo:wght@400;600;800',
  hf="Archivo, sans-serif", bf="Archivo, sans-serif", hw=800, pageBg='#ffffff', surface='#ffffff', ink='#111111', text='#111111',
  muted='#4a4a4a', accent='#111111', onAccent='#ffffff', hi='#c8102e', link='#111111', border='#111111', ib='#111111',
  hdr='plain', hrule='border-top: 8px solid #111111', hbg='#ffffff', htx='#111111', fbg='#ffffff', ftx='#4a4a4a',
  fborder='2px solid #111111', phbg='#d6d6d6', phtx='#333333')
t(n=7, stem='T07-FindingAid', name='Finding Aid First', fonts='IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500',
  hf="'IBM Plex Sans', sans-serif", bf="'IBM Plex Sans', sans-serif", hw=600, pageBg='#f4f6f8', surface='#ffffff', ink='#23292f',
  text='#23292f', muted='#55606b', accent='#0b4f8a', onAccent='#ffffff', hi='#55606b', link='#0b4f8a', border='#c5ccd3',
  ib='#77828d', hdr='bar', hrule='border-bottom: 1px solid #c5ccd3', hbg='#ffffff', htx='#23292f', fbg='#ffffff',
  ftx='#55606b', fborder='1px solid #c5ccd3', phbg='#d5dbe1', phtx='#23292f', r=3, mono="'IBM Plex Mono', monospace")
t(n=8, stem='T08-Timeline', name='Timeline', fonts='Work+Sans:wght@400;600;800',
  hf="'Work Sans', sans-serif", bf="'Work Sans', sans-serif", hw=800, pageBg='#f7f4ec', surface='#ffffff', ink='#1b2a4a',
  text='#26303f', muted='#4a5361', accent='#e6c15a', onAccent='#1b2a4a', hi='#1b2a4a', link='#1b2a4a', border='#c9c2ae',
  ib='#7a7462', hdr='bar', hbg='#1b2a4a', htx='#ffffff', fbg='#1b2a4a', ftx='#ffffff', phbg='#cfc9b8', phtx='#333a45')
t(n=9, stem='T09-MapRoom', name='Map Room', fonts='Bitter:wght@500;700&family=Karla:wght@400;600',
  hf="Bitter, serif", bf="Karla, sans-serif", pageBg='#f1ecdf', surface='#ffffff', ink='#2d2a24', text='#2d2a24',
  muted='#4f493f', accent='#7a2e12', onAccent='#ffffff', hi='#7a2e12', link='#7a2e12', border='#2d2a24', ib='#2d2a24',
  hdr='plain', hrule='border-bottom: 2px solid #2d2a24', hbg='#f1ecdf', htx='#2d2a24', fbg='#2d2a24', ftx='#f1ecdf',
  phbg='#cfc8b4', phtx='#2d2a24')
t(n=10, stem='T10-MuseumLabel', name='Museum Label', fonts='Cormorant+Garamond:wght@500;700&family=Inter:wght@400;500',
  hf="'Cormorant Garamond', serif", bf="Inter, sans-serif", pageBg='#f6f5f2', surface='#ffffff', ink='#1a1a1a', text='#1a1a1a',
  muted='#5a5a5a', accent='#1a1a1a', onAccent='#ffffff', hi='#5a5a5a', link='#1a1a1a', border='#c9c7c0', ib='#6e6c66',
  hdr='plain', hbg='#f6f5f2', htx='#1a1a1a', fbg='#f6f5f2', ftx='#5a5a5a', fborder='1px solid #1a1a1a',
  phbg='#dddbd5', phtx='#3a3a3a', item='stack', shadow='box-shadow: 0 2px 6px rgba(0,0,0,0.1);', navUpper=True)
t(n=11, stem='T11-Ledger', name='Ledger', fonts='Libre+Baskerville:wght@400;700&family=IBM+Plex+Mono:wght@400;500',
  hf="'Libre Baskerville', serif", bf="'Libre Baskerville', serif", pageBg='#eef2e6', surface='#fbfdf7', ink='#1f2a22',
  text='#1f2a22', muted='#3d4a40', accent='#1f3d2b', onAccent='#ffffff', hi='#8a1c1c', link='#1f3d2b', border='#1f3d2b',
  ib='#1f3d2b', hdr='plain', hrule='border-bottom: 3px double #1f3d2b', hbg='#eef2e6', htx='#1f2a22', fbg='#eef2e6',
  ftx='#3d4a40', fborder='3px double #1f3d2b', phbg='#d3dccb', phtx='#1f2a22', mono="'IBM Plex Mono', monospace")
t(n=12, stem='T12-Depot', name='Railroad Depot', fonts='Barlow+Condensed:wght@600;800&family=Barlow:wght@400;600',
  hf="'Barlow Condensed', sans-serif", bf="Barlow, sans-serif", hw=800, pageBg='#f3efe6', surface='#ffffff', ink='#111111',
  text='#1b1b1b', muted='#444444', accent='#111111', onAccent='#f4c430', hi='#6b4e00', link='#111111', border='#111111',
  ib='#111111', hdr='bar', hbg='#111111', htx='#ffffff', htitle='#f4c430', fbg='#111111', ftx='#ffffff',
  phbg='#cfc9bb', phtx='#1b1b1b', bw=3, case='uppercase', navUpper=True)
t(n=13, stem='T13-Blueprint', name='Blueprint', fonts='Space+Mono:wght@400;700&family=Space+Grotesk:wght@500;700',
  hf="'Space Grotesk', sans-serif", bf="'Space Mono', monospace", pageBg='#14397a',
  pageImg='background-image: linear-gradient(rgba(255,255,255,0.09) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.09) 1px, transparent 1px); background-size: 32px 32px;',
  contentBg='transparent', surface='#0e2a5c', ink='#ffffff', text='#ffffff', muted='#cfe0ff', accent='#ffffff', onAccent='#14397a',
  hi='#cfe0ff', link='#ffffff', border='#ffffff', ib='#ffffff', inputBg='#0e2a5c', hdr='plain', hrule='border-bottom: 2px solid #ffffff',
  hbg='transparent', htx='#ffffff', fbg='transparent', ftx='#cfe0ff', fborder='2px solid #ffffff', phbg='#2a4f90', phtx='#ffffff',
  bw=2, mono="'Space Mono', monospace", navUpper=True)
t(n=14, stem='T14-Postcard', name='Postcard', fonts='DM+Serif+Display&family=DM+Sans:wght@400;500;700',
  hf="'DM Serif Display', serif", bf="'DM Sans', sans-serif", hw=400, pageBg='#d8ece9', surface='#fffdf6', ink='#0d5560',
  text='#1f3336', muted='#3a5256', accent='#a6321f', onAccent='#ffffff', hi='#a6321f', link='#0d5560', border='#1f3336',
  ib='#1f3336', inputBg='#fffdf6', hdr='plain', hbg='#d8ece9', htx='#0d5560', fbg='#0d5560', ftx='#ffffff',
  phbg='#c7d6d3', phtx='#1f3336', r=4, shadow='box-shadow: 6px 6px 0 #0d5560;', results='grid')
t(n=15, stem='T15-PlainAccess', name='Plain Access', fonts='Atkinson+Hyperlegible:wght@400;700',
  hf="'Atkinson Hyperlegible', sans-serif", bf="'Atkinson Hyperlegible', sans-serif", pageBg='#ffffff', surface='#ffffff',
  ink='#000000', text='#000000', muted='#222222', accent='#00419e', onAccent='#ffffff', hi='#000000', link='#00419e',
  border='#000000', ib='#000000', hdr='plain', hrule='border-bottom: 4px solid #000000', hbg='#ffffff', htx='#000000',
  fbg='#000000', ftx='#ffffff', phbg='#d0d0d0', phtx='#000000', bw=3, base=20, skip=True, item='stack')
t(n=16, stem='T16-Courthouse', name='Courthouse', fonts='Merriweather:wght@400;700&family=Libre+Franklin:wght@400;600',
  hf="Merriweather, serif", bf="'Libre Franklin', sans-serif", pageBg='#ffffff', surface='#f1f3f6', ink='#14315c', text='#232a33',
  muted='#4a5462', accent='#14315c', onAccent='#ffffff', hi='#7a1f2b', link='#14315c', border='#b9c1cc', ib='#6b7684',
  hdr='centered', hbg='#ffffff', htx='#14315c', fbg='#14315c', ftx='#ffffff', phbg='#cdd3db', phtx='#232a33')
t(n=17, stem='T17-ContactSheet', name='Contact Sheet', fonts='Manrope:wght@400;600;800&family=JetBrains+Mono:wght@400;500',
  hf="Manrope, sans-serif", bf="Manrope, sans-serif", hw=800, pageBg='#ebebe8', surface='#ffffff', ink='#161616', text='#161616',
  muted='#444444', accent='#161616', onAccent='#ffffff', hi='#b3261e', link='#111111', border='#161616', ib='#161616',
  hdr='plain', hbg='#ebebe8', htx='#161616', fbg='#161616', ftx='#ffffff', phbg='#c4c4c0', phtx='#161616',
  mono="'JetBrains Mono', monospace", results='grid')
t(n=18, stem='T18-LibraryStacks', name='Library Stacks', fonts='Lora:wght@500;700&family=Nunito+Sans:wght@400;600;700',
  hf="Lora, serif", bf="'Nunito Sans', sans-serif", pageBg='#faf7f2', surface='#ffffff', ink='#2a2522', text='#2a2522',
  muted='#554c45', accent='#6b1d2a', onAccent='#ffffff', hi='#6b1d2a', link='#6b1d2a', border='#c9bfb2', ib='#6e635a',
  hdr='plain', hrule='border-bottom: 1px solid #c9bfb2', hbg='#faf7f2', htx='#6b1d2a', fbg='#6b1d2a', ftx='#ffffff',
  phbg='#ddd5ca', phtx='#2a2522', r=8, site='Dickinson Public Library', idno='DPL3')
t(n=19, stem='T19-CoastalLight', name='Coastal Light', fonts='Newsreader:wght@400;500&family=Inter:wght@400;500;600',
  hf="Newsreader, serif", bf="Inter, sans-serif", hw=500, pageBg='#f5f8fa', surface='#ffffff', ink='#1c2b33', text='#2b3a42',
  muted='#51636d', accent='#1f5a73', onAccent='#ffffff', hi='#51636d', link='#1f5a73', border='#c4d0d7', ib='#6c7f89',
  hdr='plain', hbg='#f5f8fa', htx='#1c2b33', fbg='#f5f8fa', ftx='#51636d', fborder='1px solid #c4d0d7',
  phbg='#d5e0e6', phtx='#2b3a42', r=4, item='stack')
t(n=20, stem='T20-NightArchive', name='Night Archive', fonts='Space+Grotesk:wght@500;700&family=Inter:wght@400;500',
  hf="'Space Grotesk', sans-serif", bf="Inter, sans-serif", pageBg='#10141a', surface='#171d26', ink='#ffffff', text='#d5dbe3',
  muted='#aab4c0', accent='#ffb454', onAccent='#1a1205', hi='#ffb454', link='#ffb454', border='#323c4a', ib='#6b7787',
  inputBg='#171d26', hdr='sidebar', hbg='#171d26', htx='#d5dbe3', fbg='#10141a', ftx='#aab4c0', fborder='1px solid #323c4a',
  phbg='#2a3442', phtx='#d5dbe3', r=10)

THEMES = []
for k in T:
    d = dict(D); d.update(k)
    if d['contentBg'] is None: d['contentBg'] = d['pageBg']
    if d['htitle'] is None: d['htitle'] = d['htx']
    THEMES.append(d)
