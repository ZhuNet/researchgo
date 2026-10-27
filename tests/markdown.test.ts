import { describe, expect, it } from 'vitest';

import { markdown } from '../src/lib/markdown';

describe('agent markdown', () => {
  it('renders pipe tables as table elements', () => {
    const html = markdown('| Name | Count |\n| :--- | ---: |\n| files | 3 |');

    expect(html).toContain('<table class="md__table">');
    expect(html).toContain('<th style="text-align:left">Name</th>');
    expect(html).toContain('<td style="text-align:right">3</td>');
    expect(html).not.toContain('<p class="md__p">| Name');
  });

  it('does not treat an ordinary pipe paragraph as a table', () => {
    expect(markdown('a | b')).toContain('<p class="md__p">a | b</p>');
  });
});
