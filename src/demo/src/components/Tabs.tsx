import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

export default function Tabs({ v }: { v: Vals }) {
  return (
      <div style={css("max-width:1080px; margin:0 auto; padding:0 var(--sp-5) var(--sp-3); box-sizing:border-box; display:flex; gap:var(--sp-2); flex-wrap:wrap")}>
            {(v.tabs || []).map((t: any, it: number) => (<React.Fragment key={it}>
              <button onClick={t.go} style={css(t.style)}>{t.label}</button>
            </React.Fragment>))}
          </div>
  );
}
