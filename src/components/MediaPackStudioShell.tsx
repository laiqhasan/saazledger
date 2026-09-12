import React from 'react';
import { MediaPackStudioModal } from './MediaPackStudioModal';
import { BackgroundIsolationModeControl } from './BackgroundIsolationModeControl';

export type MediaPackStudioShellProps = React.ComponentProps<typeof MediaPackStudioModal>;

/**
 * Optional composition helper for screens that want the isolation selector next
 * to the existing Media Pack Studio without changing its internal API.
 */
export const MediaPackStudioShell: React.FC<MediaPackStudioShellProps> = (props) => (
  <>
    <MediaPackStudioModal {...props} />
    {props.isOpen ? <BackgroundIsolationModeControl /> : null}
  </>
);
