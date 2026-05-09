import { NextResponse } from "next/server";

const UNUSABLE_EMAILS = new Set([
  "bookings@nationwidepathology.co.uk",
  "care.vl4me@nhs.net",
  "alanjcollett@gmail.com",
]);
const HUBSPOT_CALL_DELAY_MS = 200;
const HUBSPOT_RETRY_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeEmail(email?: string | null): string | undefined {
  if (!email) {
    return undefined;
  }

  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.indexOf("@");
  const dotIndex = trimmed.lastIndexOf(".");

  if (atIndex <= 0 || dotIndex <= atIndex + 1 || dotIndex === trimmed.length - 1) {
    return undefined;
  }

  if (UNUSABLE_EMAILS.has(trimmed)) {
    return undefined;
  }

  return trimmed;
}

type HubSpotContact = {
  id: string;
  properties?: {
    semble_patient_id?: string | null;
  };
};

type HubSpotSearchFilter = {
  propertyName: string;
  operator: "EQ" | "HAS_PROPERTY";
  value?: string;
};

async function fetchHubSpot(url: string, init: RequestInit): Promise<Response> {
  await sleep(HUBSPOT_CALL_DELAY_MS);
  let response = await fetch(url, init);
  if (response.status === 429) {
    await sleep(HUBSPOT_RETRY_DELAY_MS);
    response = await fetch(url, init);
  }
  return response;
}

async function searchHubSpotContact(
  filters: HubSpotSearchFilter[],
): Promise<{ id?: string; semblePatientId?: string; status: number; error?: string }> {
  const response = await fetchHubSpot("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [{ filters }],
      properties: ["semble_patient_id"],
      limit: 1,
    }),
  });

  if (!response.ok) {
    return {
      status: response.status,
      error: (await response.text()) || "Failed to search HubSpot contact",
    };
  }

  const data = await response.json();
  const contact = data?.results?.[0];
  return {
    id: contact?.id as string | undefined,
    semblePatientId: (contact?.properties?.semble_patient_id as string | undefined) ?? undefined,
    status: response.status,
  };
}

async function fetchAllHubSpotSemblePatientIds(): Promise<{
  ids: Set<string>;
  count: number;
  error?: string;
  status?: number;
}> {
  const ids = new Set<string>();
  let after: string | undefined;

  while (true) {
    const response = await fetchHubSpot("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [{ propertyName: "semble_patient_id", operator: "HAS_PROPERTY" }],
          },
        ],
        properties: ["semble_patient_id"],
        limit: 100,
        ...(after ? { after } : {}),
      }),
    });

    if (!response.ok) {
      return {
        ids,
        count: ids.size,
        status: response.status,
        error: (await response.text()) || "Failed to fetch HubSpot contacts with semble_patient_id",
      };
    }

    const data = await response.json();
    const results = (data?.results ?? []) as HubSpotContact[];
    for (const contact of results) {
      const semblePatientId = String(contact?.properties?.semble_patient_id ?? "").trim();
      if (semblePatientId) {
        ids.add(semblePatientId);
      }
    }

    const nextAfter = data?.paging?.next?.after as string | undefined;
    if (!nextAfter) {
      break;
    }
    after = nextAfter;
  }

  return { ids, count: ids.size };
}

export async function GET() {
  const pageSize = 100;
  let page = 1;
  let fetchedFromSemble = 0;
  let skippedExisting = 0;
  let skippedNoPhone = 0;
  let created = 0;
  let backfilledMissingSembleId = 0;
  let failed = 0;
  const failedPatients: Array<{
    patientId: string;
    name: string;
    email: string | null;
    phone: string | null;
    status: number | null;
    error: string;
  }> = [];

  try {
    const hubSpotIdsResult = await fetchAllHubSpotSemblePatientIds();
    if (hubSpotIdsResult.error) {
      return NextResponse.json(
        {
          success: false,
          message: "Failed to fetch existing HubSpot semble_patient_id values",
          status: hubSpotIdsResult.status ?? 500,
          error: hubSpotIdsResult.error,
        },
        { status: 500 },
      );
    }

    const existingHubSpotSembleIds = hubSpotIdsResult.ids;
    const upsertWithEmailRetry = async (
      method: "PATCH" | "POST",
      url: string,
      properties: Record<string, string>,
    ) => {
      const runRequest = async (requestProperties: Record<string, string>) =>
        fetchHubSpot(url, {
          method,
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ properties: requestProperties }),
        });

      let response = await runRequest(properties);
      if (response.ok) {
        return response;
      }

      if (properties.email && response.status === 409) {
        const retryProperties = { ...properties };
        delete retryProperties.email;
        response = await runRequest(retryProperties);
      }

      return response;
    };

    while (true) {
      const sembleResponse = await fetch(process.env.SEMBLE_API_URL!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-token": process.env.SEMBLE_API_KEY!,
        },
        body: JSON.stringify({
          query: `
            query {
              patients(pagination: { page: ${page}, pageSize: 100 }) {
                data {
                  id
                  firstName
                  lastName
                  email
                  phones {
                    phoneType
                    phoneNumber
                  }
                }
              }
            }
          `,
        }),
      });

      if (!sembleResponse.ok) {
        const errorBody = await sembleResponse.text();
        return NextResponse.json(
          {
            success: false,
            message: "Failed to fetch patients from Semble",
            status: sembleResponse.status,
            error: errorBody,
            page,
          },
          { status: 500 },
        );
      }

      const sembleData = await sembleResponse.json();
      const patients = sembleData?.data?.patients?.data ?? [];

      if (!Array.isArray(patients)) {
        return NextResponse.json(
          {
            success: false,
            message: "Unexpected Semble response format",
            page,
            sembleData,
          },
          { status: 500 },
        );
      }

      if (patients.length === 0) {
        break;
      }

      fetchedFromSemble += patients.length;

      for (const patient of patients) {
        const patientId = String(patient?.id ?? "").trim();
        const patientName = `${patient?.firstName ?? ""} ${patient?.lastName ?? ""}`.trim();
        const phoneNumber = patient?.phones?.find(
          (phone: { phoneNumber?: string }) => Boolean(phone?.phoneNumber),
        )?.phoneNumber;
        const email = sanitizeEmail(patient?.email);

        if (!phoneNumber) {
          skippedNoPhone += 1;
          continue;
        }

        if (!patientId) {
          failed += 1;
          failedPatients.push({
            patientId,
            name: patientName,
            email: email ?? null,
            phone: phoneNumber ?? null,
            status: null,
            error: "Semble patient id is missing",
          });
          continue;
        }

        const properties: Record<string, string> = {
          firstname: patient.firstName ?? "",
          lastname: patient.lastName ?? "",
          phone: phoneNumber,
          semble_patient_id: patientId,
        };

        try {
          let existingContact = await searchHubSpotContact([
            {
              propertyName: "semble_patient_id",
              operator: "EQ",
              value: patientId,
            },
          ]);
          if (existingContact.error) {
            throw new Error(existingContact.error);
          }

          if (!existingContact.id) {
            existingContact = await searchHubSpotContact([
              {
                propertyName: "firstname",
                operator: "EQ",
                value: patient.firstName ?? "",
              },
              {
                propertyName: "lastname",
                operator: "EQ",
                value: patient.lastName ?? "",
              },
              {
                propertyName: "phone",
                operator: "EQ",
                value: phoneNumber,
              },
            ]);
            if (existingContact.error) {
              throw new Error(existingContact.error);
            }
          }

          if (!existingContact.id && email) {
            existingContact = await searchHubSpotContact([
              {
                propertyName: "firstname",
                operator: "EQ",
                value: patient.firstName ?? "",
              },
              {
                propertyName: "lastname",
                operator: "EQ",
                value: patient.lastName ?? "",
              },
              {
                propertyName: "email",
                operator: "EQ",
                value: email,
              },
            ]);
            if (existingContact.error) {
              throw new Error(existingContact.error);
            }
          }

          if (existingContact.id) {
            skippedExisting += 1;
            if (!existingContact.semblePatientId) {
              if (email) {
                const emailSearch = await searchHubSpotContact([
                  {
                    propertyName: "email",
                    operator: "EQ",
                    value: email,
                  },
                ]);
                if (emailSearch.error) {
                  throw new Error(emailSearch.error);
                }
                if (!emailSearch.id || emailSearch.id === existingContact.id) {
                  properties.email = email;
                }
              }

              const updateResponse = await upsertWithEmailRetry(
                "PATCH",
                `https://api.hubapi.com/crm/v3/objects/contacts/${existingContact.id}`,
                properties,
              );
              if (!updateResponse.ok) {
                const errorBody = await updateResponse.text();
                failed += 1;
                failedPatients.push({
                  patientId,
                  name: patientName,
                  email: email ?? null,
                  phone: phoneNumber,
                  status: updateResponse.status,
                  error: errorBody || "Failed to update HubSpot contact",
                });
                continue;
              }

              backfilledMissingSembleId += 1;
              existingHubSpotSembleIds.add(patientId);
            }
            continue;
          }

          if (email) {
            const emailSearch = await searchHubSpotContact([
              {
                propertyName: "email",
                operator: "EQ",
                value: email,
              },
            ]);
            if (emailSearch.error) {
              throw new Error(emailSearch.error);
            }
            if (!emailSearch.id) {
              properties.email = email;
            }
          }

          const createResponse = await upsertWithEmailRetry(
            "POST",
            "https://api.hubapi.com/crm/v3/objects/contacts",
            properties,
          );

          if (!createResponse.ok) {
            const errorBody = await createResponse.text();
            failed += 1;
            failedPatients.push({
              patientId,
              name: patientName,
              email: email ?? null,
              phone: phoneNumber,
              status: createResponse.status,
              error: errorBody || "Failed to create HubSpot contact",
            });
            continue;
          }

          created += 1;
          existingHubSpotSembleIds.add(patientId);
        } catch (error) {
          failed += 1;
          failedPatients.push({
            patientId,
            name: patientName,
            email: email ?? null,
            phone: phoneNumber ?? null,
            status: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      page += 1;
    }

    return NextResponse.json({
      success: true,
      fetchedFromSemble,
      existingHubSpotIds: hubSpotIdsResult.count,
      skippedExisting,
      skippedNoPhone,
      created,
      backfilledMissingSembleId,
      failed,
      pagesProcessed: page - 1,
      failedPatients,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: "Unexpected sync error",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
