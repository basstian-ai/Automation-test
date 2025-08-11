'use strict';

function strategyFor(issue) {
  switch (issue?.hint) {
    case 'nextjs_duplicate_page':
      return [
        'Pick a single source of truth for the route.',
        'Prefer directory index (e.g., pages/admin/index.*) over sibling file (pages/admin.*).',
        'Delete the duplicate and update imports/links if needed.'
      ];
    case 'missing_default_export':
      return [
        'Open the target module and check exports.',
        'If there is no default export, change call-sites to use named import (e.g., `import { slugify } from ...`).',
        'If multiple call-sites assume default, consider adding a tiny default re-export shim.'
      ];
    default:
      return [];
  }
}

module.exports = { strategyFor };
