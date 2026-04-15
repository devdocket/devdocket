import { createLoggerService } from '@devdocket/shared';

export { LogLevel, resolveLogLevel, serializeArg } from '@devdocket/shared';

const service = createLoggerService();

export const logger = service.logger;
export const initLogger = service.initLogger;
export const setLogLevel = service.setLogLevel;
