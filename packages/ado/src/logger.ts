export type { Logger } from '@devdocket/shared';
import { createModuleLogger } from '@devdocket/shared';

const { logger, setLogger } = createModuleLogger();
export { logger, setLogger };
