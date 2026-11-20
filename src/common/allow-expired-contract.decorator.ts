import { SetMetadata } from '@nestjs/common';

export const ALLOW_EXPIRED_CONTRACT_KEY = 'allowExpiredContract';

/** Routes a workspace can still reach after its contract ended: seeing the contract, asking for a renewal, the own account. */
export const AllowExpiredContract = () => SetMetadata(ALLOW_EXPIRED_CONTRACT_KEY, true);
