/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useFetcher } from '@kbn/observability-plugin/public';
import { useEffect } from 'react';
import { useKibana } from '@kbn/kibana-react-plugin/public';
import { useSelector } from 'react-redux';
import { serviceLocationsSelector } from '../../state/monitor_management/selectors';
import { showSyncErrors } from '../monitor_management/show_sync_errors';
import { createMonitorAPI } from '../../state/monitor_management/api';
import { DEFAULT_FIELDS } from '../../../../../common/constants/monitor_defaults';
import { ConfigKey } from '../../../../../common/constants/monitor_management';
import { DataStream, SyntheticsMonitorWithId } from '../../../../../common/runtime_types';
import { MONITOR_SUCCESS_LABEL, MY_FIRST_MONITOR, SimpleFormData } from './simple_monitor_form';
import { kibanaService } from '../../../../utils/kibana_service';

export const useSimpleMonitor = ({ monitorData }: { monitorData?: SimpleFormData }) => {
  const { application } = useKibana().services;
  const locationsList = useSelector(serviceLocationsSelector);

  const { data, loading } = useFetcher(() => {
    if (!monitorData) {
      return new Promise<undefined>((resolve) => resolve(undefined));
    }
    const { urls, locations } = monitorData;

    return createMonitorAPI({
      monitor: {
        ...DEFAULT_FIELDS.browser,
        'source.inline.script': `step('Go to ${urls}', async () => {
  await page.goto('${urls}');
});`,
        [ConfigKey.MONITOR_TYPE]: DataStream.BROWSER,
        [ConfigKey.NAME]: MY_FIRST_MONITOR,
        [ConfigKey.LOCATIONS]: locations,
        [ConfigKey.URLS]: urls,
      },
    });
  }, [monitorData]);

  useEffect(() => {
    const newMonitor = data as SyntheticsMonitorWithId;
    const hasErrors = data && 'attributes' in data && data.attributes.errors?.length > 0;
    if (hasErrors && !loading) {
      showSyncErrors(data.attributes.errors, locationsList, kibanaService.toasts);
    }

    if (!loading && newMonitor?.id) {
      kibanaService.toasts.addSuccess({
        title: MONITOR_SUCCESS_LABEL,
        toastLifeTimeMs: 3000,
      });
      application?.navigateToApp('uptime', { path: `/monitor/${btoa(newMonitor.id)}` });
    }
  }, [application, data, loading, locationsList]);

  return { data, loading };
};
