/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { IHttpFetchError } from '@kbn/core/public';
import { createAction } from '@reduxjs/toolkit';
import { StatesIndexStatus } from '../../../../../common/runtime_types';

export const getIndexStatus = createAction<void>('[INDEX STATUS] GET');
export const getIndexStatusSuccess = createAction<StatesIndexStatus>('[INDEX STATUS] GET SUCCESS');
export const getIndexStatusFail = createAction<IHttpFetchError>('[INDEX STATUS] GET FAIL');
