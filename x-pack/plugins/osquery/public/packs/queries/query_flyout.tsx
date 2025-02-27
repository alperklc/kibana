/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { map } from 'lodash';
import {
  EuiFlyout,
  EuiTitle,
  EuiSpacer,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiFlyoutFooter,
  EuiFlexGroup,
  EuiFlexItem,
  EuiButtonEmpty,
  EuiButton,
  EuiText,
} from '@elastic/eui';
import React, { useCallback, useMemo, useState } from 'react';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';

import { CodeEditorField } from '../../saved_queries/form/code_editor_field';
import { Form, getUseField, Field } from '../../shared_imports';
import { PlatformCheckBoxGroupField } from './platform_checkbox_group_field';
import { ALL_OSQUERY_VERSIONS_OPTIONS } from './constants';
import { UsePackQueryFormProps, PackFormData, usePackQueryForm } from './use_pack_query_form';
import { SavedQueriesDropdown } from '../../saved_queries/saved_queries_dropdown';
import { ECSMappingEditorField } from './lazy_ecs_mapping_editor_field';
import { useKibana } from '../../common/lib/kibana';

const CommonUseField = getUseField({ component: Field });

interface QueryFlyoutProps {
  uniqueQueryIds: string[];
  defaultValue?: UsePackQueryFormProps['defaultValue'] | undefined;
  onSave: (payload: PackFormData) => Promise<void>;
  onClose: () => void;
}

const QueryFlyoutComponent: React.FC<QueryFlyoutProps> = ({
  uniqueQueryIds,
  defaultValue,
  onSave,
  onClose,
}) => {
  const permissions = useKibana().services.application.capabilities.osquery;
  const [isEditMode] = useState(!!defaultValue);
  const { form } = usePackQueryForm({
    uniqueQueryIds,
    defaultValue,
    handleSubmit: async (payload, isValid) =>
      new Promise((resolve) => {
        if (isValid) {
          onSave(payload);
          onClose();
        }

        resolve();
      }),
  });

  const { submit, isSubmitting, updateFieldValues } = form;

  const handleSetQueryValue = useCallback(
    (savedQuery) => {
      if (savedQuery) {
        updateFieldValues({
          id: savedQuery.id,
          query: savedQuery.query,
          description: savedQuery.description,
          platform: savedQuery.platform,
          version: savedQuery.version,
          interval: savedQuery.interval,
          // @ts-expect-error update types
          ecs_mapping:
            map(savedQuery.ecs_mapping, (value, key) => ({
              key,
              result: {
                type: Object.keys(value)[0],
                value: Object.values(value)[0],
              },
            })) ?? [],
        });
      }
    },
    [updateFieldValues]
  );
  /* Avoids accidental closing of the flyout when the user clicks outside of the flyout */
  const maskProps = useMemo(() => ({ onClick: () => ({}) }), []);

  return (
    <EuiFlyout
      size="m"
      onClose={onClose}
      aria-labelledby="flyoutTitle"
      outsideClickCloses={false}
      maskProps={maskProps}
    >
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="s">
          <h2 id="flyoutTitle">
            {isEditMode ? (
              <FormattedMessage
                id="xpack.osquery.queryFlyoutForm.editFormTitle"
                defaultMessage="Edit query"
              />
            ) : (
              <FormattedMessage
                id="xpack.osquery.queryFlyoutForm.addFormTitle"
                defaultMessage="Attach next query"
              />
            )}
          </h2>
        </EuiTitle>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        <Form form={form}>
          {!isEditMode && permissions.readSavedQueries ? (
            <>
              <SavedQueriesDropdown onChange={handleSetQueryValue} />
              <EuiSpacer />
            </>
          ) : null}
          <CommonUseField path="id" />
          <EuiSpacer />
          <CommonUseField path="query" component={CodeEditorField} />
          <EuiSpacer />
          <EuiFlexGroup>
            <EuiFlexItem>
              <CommonUseField
                path="interval"
                // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop
                euiFieldProps={{ append: 's' }}
              />
              <EuiSpacer />
              <CommonUseField
                path="version"
                labelAppend={
                  <EuiFlexItem grow={false}>
                    <EuiText size="xs" color="subdued">
                      <FormattedMessage
                        id="xpack.osquery.queryFlyoutForm.versionFieldOptionalLabel"
                        defaultMessage="(optional)"
                      />
                    </EuiText>
                  </EuiFlexItem>
                }
                // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop
                euiFieldProps={{
                  noSuggestions: false,
                  singleSelection: { asPlainText: true },
                  placeholder: i18n.translate('xpack.osquery.queriesTable.osqueryVersionAllLabel', {
                    defaultMessage: 'ALL',
                  }),
                  options: ALL_OSQUERY_VERSIONS_OPTIONS,
                  onCreateOption: undefined,
                }}
              />
            </EuiFlexItem>
            <EuiFlexItem>
              <CommonUseField path="platform" component={PlatformCheckBoxGroupField} />
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer />
          <EuiFlexGroup>
            <EuiFlexItem>
              <ECSMappingEditorField />
            </EuiFlexItem>
          </EuiFlexGroup>
        </Form>
      </EuiFlyoutBody>
      <EuiFlyoutFooter>
        <EuiFlexGroup justifyContent="spaceBetween">
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty iconType="cross" onClick={onClose} flush="left">
              <FormattedMessage
                id="xpack.osquery.queryFlyoutForm.cancelButtonLabel"
                defaultMessage="Cancel"
              />
            </EuiButtonEmpty>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton isLoading={isSubmitting} onClick={submit} fill>
              <FormattedMessage
                id="xpack.osquery.queryFlyoutForm.saveButtonLabel"
                defaultMessage="Save"
              />
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutFooter>
    </EuiFlyout>
  );
};

export const QueryFlyout = React.memo(QueryFlyoutComponent);
