/**
 * A small invented fandom, used so the ingest suite runs with no network.
 *
 * Deliberately includes the shapes that break naive parsers: nested templates,
 * `<br/>`-separated multi-value fields, piped links, a page whose infobox is
 * unterminated, and one page that is nearly empty.
 */
import type { WikiPage } from '../../src/ingest/client.ts';

export const WIKI: Record<string, Partial<WikiPage> & { title: string }> = {
  'Duskhollow': {
    title: 'Duskhollow',
    pageId: '1',
    revision: '101',
    categories: ['Locations', 'Cities of the Vale', 'Ashgrove Arc'],
    wikitext: `{{Infobox location
| name = Duskhollow
| region = [[The Ashen Vale]]
| population = {{formatnum:12000}}
| ruler = [[Warden Ilsa Crowe]]
| terrain = river gorge
}}
'''Duskhollow''' is a terraced city built into the walls of a river gorge in [[The Ashen Vale]]. It is governed by the [[Wardens of the Vale]] and known for its bridge markets.

== History ==
Founded after the [[Sundering of Marrow]], the city grew around the crossing.

== Notable residents ==
* [[Warden Ilsa Crowe]]
* [[Bram the Lesser]]

== See also ==
* [[Index of Vale Topics]]`,
  },

  'Warden Ilsa Crowe': {
    title: 'Warden Ilsa Crowe',
    pageId: '2',
    revision: '102',
    categories: ['Characters', 'Wardens', 'Ashgrove Arc'],
    wikitext: `{{Infobox character
| name = Ilsa Crowe
| species = Human
| status = Alive
| occupation = Warden of Duskhollow
| affiliation = [[Wardens of the Vale]]<br/>[[The Bridge Council]]
| relatives = [[Bram the Lesser]] (brother)
| location = [[Duskhollow]]
| allies = [[Bram the Lesser]]
| enemies = [[The Cinder Compact]]
| born = {{Date|412|AV}}
}}
'''Ilsa Crowe''' is the Warden of [[Duskhollow]] and the ranking officer of the [[Wardens of the Vale]].

She is known for terse pronouncements. "The bridge stays open. That is the whole of my policy."

Later she remarked, "I have buried better people than you for less."

== Career ==
Crowe took the wardenship after the [[Sundering of Marrow]].`,
  },

  'Bram the Lesser': {
    title: 'Bram the Lesser',
    pageId: '3',
    revision: '103',
    categories: ['Characters', 'Ashgrove Arc'],
    wikitext: `{{Infobox character
| name = Bram Crowe
| species = Human
| status = Deceased
| occupation = Bridge factor
| affiliation = [[The Bridge Council]]
| relatives = [[Warden Ilsa Crowe]] (sister)
| location = [[Duskhollow]]
}}
'''Bram the Lesser''' was a bridge factor of [[Duskhollow]] and brother to [[Warden Ilsa Crowe]]. He died during the [[Cinder Riots]].`,
  },

  'Wardens of the Vale': {
    title: 'Wardens of the Vale',
    pageId: '4',
    revision: '104',
    categories: ['Organizations', 'Ashgrove Arc'],
    wikitext: `{{Infobox organization
| name = Wardens of the Vale
| leader = [[Warden Ilsa Crowe]]
| headquarters = [[Duskhollow]]
| founded = 388 AV
| enemies = [[The Cinder Compact]]
}}
The '''Wardens of the Vale''' are the standing constabulary of [[The Ashen Vale]].`,
  },

  'The Cinder Compact': {
    title: 'The Cinder Compact',
    pageId: '5',
    revision: '105',
    categories: ['Organizations', 'Ashgrove Arc'],
    wikitext: `{{Infobox organization
| name = The Cinder Compact
| leader = [[Vesh Auld]]
| headquarters = [[Emberfall]]
| enemies = [[Wardens of the Vale]]
}}
The '''Cinder Compact''' is a smuggling combine operating out of [[Emberfall]].`,
  },

  'Vesh Auld': {
    title: 'Vesh Auld',
    pageId: '6',
    revision: '106',
    categories: ['Characters', 'Ashgrove Arc'],
    wikitext: `{{Infobox character
| name = Vesh Auld
| species = Human
| status = Alive
| occupation = Compact factor
| affiliation = [[The Cinder Compact]]
| location = [[Emberfall]]
| enemies = [[Warden Ilsa Crowe]]
}}
'''Vesh Auld''' leads the [[The Cinder Compact]] from [[Emberfall]]. "Everything is for sale. The trick is knowing who is buying."`,
  },

  'Emberfall': {
    title: 'Emberfall',
    pageId: '7',
    revision: '107',
    categories: ['Locations', 'Ashgrove Arc'],
    wikitext: `{{Infobox location
| name = Emberfall
| region = [[The Ashen Vale]]
| terrain = slag flats
}}
'''Emberfall''' is a smelting town on the slag flats of [[The Ashen Vale]].`,
  },

  'The Ashen Vale': {
    title: 'The Ashen Vale',
    pageId: '8',
    revision: '108',
    categories: ['Locations', 'Regions'],
    wikitext: `{{Infobox location
| name = The Ashen Vale
| terrain = volcanic valley
}}
'''The Ashen Vale''' is a volcanic valley containing [[Duskhollow]] and [[Emberfall]].`,
  },

  // Nested templates and a piped link inside an infobox value.
  'The Bridge Council': {
    title: 'The Bridge Council',
    pageId: '9',
    revision: '109',
    categories: ['Organizations', 'Ashgrove Arc'],
    wikitext: `{{Infobox organization
| name = {{PAGENAME}}
| leader = {{nowrap|[[Warden Ilsa Crowe|Ilsa Crowe]]}}
| headquarters = [[Duskhollow]]
| members = [[Warden Ilsa Crowe]]; [[Bram the Lesser]]
| founded = {{Date|390|AV}}
}}
The '''Bridge Council''' sets tolls on the [[Duskhollow]] crossings.

{| class="wikitable"
! Toll !! Rate
|-
| Cart || 3 marks
|}`,
  },

  // Unterminated infobox: must not lose the page or hang the parser.
  'Sundering of Marrow': {
    title: 'Sundering of Marrow',
    pageId: '10',
    revision: '110',
    categories: ['Events', 'Ashgrove Arc'],
    wikitext: `{{Infobox event
| name = Sundering of Marrow
| date = 388 AV
| location = [[The Ashen Vale]]
'''The Sundering of Marrow''' split the vale and founded [[Duskhollow]].`,
  },

  // Nearly empty: should be skipped rather than creating a hollow entity.
  'Marrowstub': {
    title: 'Marrowstub',
    pageId: '11',
    revision: '111',
    categories: ['Stubs'],
    wikitext: '{{stub}}',
  },

  // A hub linked from everywhere but belonging to no arc: the page that raw
  // link-count ranking would wrongly promote to the top.
  'Index of Vale Topics': {
    title: 'Index of Vale Topics',
    pageId: '12',
    revision: '112',
    categories: ['Indexes'],
    wikitext: `A list of everything.
* [[Duskhollow]]
* [[Emberfall]]
* [[The Ashen Vale]]
* [[Warden Ilsa Crowe]]
* [[Bram the Lesser]]
* [[Vesh Auld]]
* [[Wardens of the Vale]]
* [[The Cinder Compact]]
* [[The Bridge Council]]
* [[Sundering of Marrow]]
* [[Cinder Riots]]`,
  },

  'Cinder Riots': {
    title: 'Cinder Riots',
    pageId: '13',
    revision: '113',
    categories: ['Events', 'Ashgrove Arc'],
    wikitext: `{{Infobox event
| name = Cinder Riots
| date = 431 AV
| location = [[Duskhollow]]
}}
The '''Cinder Riots''' broke out over bridge tolls. [[Bram the Lesser]] died in the crush.`,
  },
};

/** Adds an outgoing link list to every fixture, as the real API would return. */
for (const page of Object.values(WIKI)) {
  if (page.links) continue;
  const links = new Set<string>();
  for (const m of (page.wikitext ?? '').matchAll(/\[\[([^\]|#]+)/g)) {
    const t = m[1]?.trim();
    if (t && !/^(File|Image|Category|Template):/i.test(t) && WIKI[t]) links.add(t);
  }
  page.links = [...links];
}
