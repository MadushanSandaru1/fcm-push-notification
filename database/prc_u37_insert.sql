-- Requires the existing fin_user.u37_push_notification_devices table.
-- Resolve existing duplicates before creating this index.
BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM fin_user.u37_push_notification_devices
        WHERE u37_u09_login_id IS NOT NULL
          AND u37_m01_org_id IS NOT NULL
          AND u37_devide_id IS NOT NULL
        GROUP BY u37_u09_login_id, u37_m01_org_id, u37_devide_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate login/org/device combinations prevent creation of the required unique index'
            USING HINT = 'Review and resolve duplicate records, then rerun this script. No records are deleted by this script.';
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_u37_login_org_device
    ON fin_user.u37_push_notification_devices (
        u37_u09_login_id,
        u37_m01_org_id,
        u37_devide_id
    );

-- IF NOT EXISTS only checks the index name, not its definition.
-- EXPLAIN validates ON CONFLICT without inserting a row or allocating an ID.
DO $$
BEGIN
    EXECUTE 'EXPLAIN INSERT INTO fin_user.u37_push_notification_devices
        (u37_u09_login_id, u37_m01_org_id, u37_devide_id)
        VALUES (NULL, NULL, NULL)
        ON CONFLICT (u37_u09_login_id, u37_m01_org_id, u37_devide_id)
        DO UPDATE SET u37_token = EXCLUDED.u37_token';
EXCEPTION
    WHEN SQLSTATE '42P10' THEN
        RAISE EXCEPTION 'No usable unique index exists for login/org/device on fin_user.u37_push_notification_devices'
            USING HINT = 'Inspect pg_indexes: an index named idx_u37_login_org_device may already exist with a different definition. Create a unique index on exactly u37_u09_login_id, u37_m01_org_id, u37_devide_id.';
END;
$$;

-- OUT parameter changes require replacing the previous signature.
DROP PROCEDURE IF EXISTS fin_user.prc_u37_insert(
    integer, integer, integer, varchar, text
);

CREATE OR REPLACE PROCEDURE fin_user.prc_u37_insert(
    IN  p_login_id      integer,
    IN  p_cus_id        integer,
    IN  p_org_id        integer,
    IN  p_device_id     varchar,
    IN  p_token         text,
    OUT p_status        integer,
    OUT p_error_message text
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_type integer;
BEGIN
    p_status := 0;
    p_error_message := NULL;

    IF p_login_id IS NULL OR p_cus_id IS NULL
       OR p_org_id IS NULL OR p_device_id IS NULL THEN
        RAISE EXCEPTION
            'Login ID, customer ID, organization ID, and device ID are required';
    END IF;

    SELECT cms.c01_id
    INTO STRICT v_type
    FROM fin_master.c01_multi_selection AS cms
    WHERE cms.c01_record_type = 95
      AND cms.c01_type_wise_id = 1
      AND cms.c01_c01_app_status_id = 1
      AND cms.c01_c01_status_id = 1
      AND cms.c01_m01_org_id = p_org_id;

    INSERT INTO fin_user.u37_push_notification_devices (
        u37_id, u37_u09_login_id, u37_u03_cus_id, u37_m01_org_id,
        u37_u01_created_by_id, u37_created_date,
        u37_u01_updated_by_id, u37_updated_date,
        u37_c01_app_status_id, u37_c01_status_id,
        u37_devide_id, u37_token, u37_type
    ) VALUES (
        fin_master.get_next_sequence('U37_PUSH_NOTIFICATION_DEVICES'),
        p_login_id, p_cus_id, p_org_id, 0, LOCALTIMESTAMP,
        0, LOCALTIMESTAMP,
        1, 1, p_device_id, p_token, v_type
    )
    ON CONFLICT (u37_u09_login_id, u37_m01_org_id, u37_devide_id)
    DO UPDATE SET
        u37_token = EXCLUDED.u37_token,
        u37_u01_updated_by_id = 0,
        u37_updated_date = LOCALTIMESTAMP,
        u37_c01_app_status_id = 1,
        u37_c01_status_id = 1;

    p_status := 1;
EXCEPTION
    WHEN NO_DATA_FOUND THEN
        p_status := 0;
        p_error_message := format(
            'No notification type found for organization %s', p_org_id
        );
    WHEN TOO_MANY_ROWS THEN
        p_status := 0;
        p_error_message := format(
            'Multiple notification types found for organization %s', p_org_id
        );
    WHEN OTHERS THEN
        p_status := 0;
        p_error_message := SQLSTATE || ': ' || SQLERRM;
END;
$$;

COMMIT;

-- Example call:
-- CALL fin_user.prc_u37_insert(
--     p_login_id      => 1001,
--     p_cus_id        => 2001,
--     p_org_id        => 1,
--     p_device_id     => 'device-unique-id',
--     p_token         => 'received-fcm-token',
--     p_status        => NULL,
--     p_error_message => NULL
-- );
