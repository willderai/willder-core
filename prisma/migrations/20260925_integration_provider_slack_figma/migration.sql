-- Item oauth-connectors-20260919: per-org OAuth for the Slack and Figma
-- knowledge-source connectors stores its token on an Integration row, beside the
-- Gmail/Outlook mailboxes. Additive enum values only; no existing row changes.

ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'slack';
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'figma';
